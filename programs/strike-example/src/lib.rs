use anchor_lang::prelude::*;
use solana_program::hash::hash;

declare_id!("Aq18qW6eoU9ugFtUBcsknFzXpaTapfPL1vSNrxLEieBm");

const MAX_SIGNERS: usize = 10; // N
const DOMAIN_SEPARATOR: &str = "strike-protocol-v1";

#[program]
pub mod strike_example {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        m_threshold: u8,
        signers: Vec<Pubkey>,
    ) -> Result<()> {
        let signers_len = signers.len();

        require!(
            signers_len > 0 && signers_len <= MAX_SIGNERS,
            ErrorCode::InvalidSignersCount
        );
        require!(
            m_threshold > 0 && (m_threshold as usize) <= signers_len,
            ErrorCode::InvalidThreshold
        );

        // Check for duplicate signers
        for i in 0..signers_len {
            for j in (i + 1)..signers_len {
                require!(signers[i] != signers[j], ErrorCode::DuplicateSigner);
            }
        }

        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.m_threshold = m_threshold;
        vault.signers = signers;
        vault.bump = ctx.bumps.vault;

        msg!(
            "Vault initialized: m={}, n={}, authority={}",
            m_threshold,
            signers_len,
            vault.authority
        );

        Ok(())
    }

    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        // Validate treasury is system-owned.
        require!(
            ctx.accounts.treasury.owner == &system_program::ID,
            ErrorCode::InvalidTreasuryOwner
        );

        // Instruct trasfer from user -> treasury.
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.user.key(),
            &ctx.accounts.treasury.key(),
            amount,
        );

        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        msg!(
            "Deposit: user={}, amount={}, treasury_balance={}",
            ctx.accounts.user.key(),
            amount,
            ctx.accounts.treasury.to_account_info().lamports()
        );

        Ok(())
    }

    pub fn withdraw_sol(
        ctx: Context<WithdrawSol>,
        ticket: WithdrawalTicket,
        signers_with_sigs: Vec<SignerWithSignature>,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        // 1. Validate ticket basic fields
        require!(ticket.amount > 0, ErrorCode::InvalidAmount);
        require!(ticket.vault == vault.key(), ErrorCode::InvalidVault);
        require!(
            ticket.recipient == ctx.accounts.recipient.key(),
            ErrorCode::InvalidRecipient
        );

        // 2. Check expiry
        require!(
            clock.unix_timestamp <= ticket.expiry,
            ErrorCode::TicketExpired
        );

        // 3. Check nonce hasn't been used (replay protection)
        let nonce_account = &mut ctx.accounts.nonce_account;
        require!(!nonce_account.used, ErrorCode::NonceAlreadyUsed);

        // 4. Verify we have enough signatures
        require!(
            signers_with_sigs.len() >= vault.m_threshold as usize,
            ErrorCode::InsufficientSignatures
        );

        // 5. Compute message hash
        let message_hash = ticket.hash();

        // 6. Verify M-of-N Ed25519 signatures
        let mut unique_valid_signers = std::collections::HashSet::new();

        for signer_sig in signers_with_sigs.iter() {
            // Verify this is an authorized signer
            if !vault.signers.contains(&signer_sig.pubkey) {
                continue;
            }

            // Verify Ed25519 signature
            if verify_ed25519_signature_from_instructions(
                &ctx.accounts.instructions,
                &message_hash,
                &signer_sig.signature,
                &signer_sig.pubkey.to_bytes(),
            )? {
                unique_valid_signers.insert(signer_sig.pubkey);
            }
        }

        require!(
            unique_valid_signers.len() >= vault.m_threshold as usize,
            ErrorCode::InsufficientValidSignatures
        );

        // 7. Validate treasury ownership
        require!(
            ctx.accounts.treasury.owner == &system_program::ID,
            ErrorCode::InvalidTreasuryOwner
        );

        // 8. Check sufficient balance
        let treasury_balance = ctx.accounts.treasury.lamports();
        let rent_exempt_minimum =
            Rent::get()?.minimum_balance(ctx.accounts.treasury.to_account_info().data_len());
        let available = treasury_balance.saturating_sub(rent_exempt_minimum);

        require!(available >= ticket.amount, ErrorCode::InsufficientFunds);

        // 9. Mark nonce as used BEFORE transfer (prevent reentrancy)
        nonce_account.used = true;

        // 10. Execute transfer
        let vault_key = vault.key();
        let seeds = &[b"treasury", vault_key.as_ref(), &[ctx.bumps.treasury]];
        let signer_seeds = &[&seeds[..]];

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.treasury.key(),
            &ctx.accounts.recipient.key(),
            ticket.amount,
        );

        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.recipient.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        msg!(
            "Withdrawal executed: request_id={}, recipient={}, amount={}, valid_signers={}",
            ticket.request_id,
            ticket.recipient,
            ticket.amount,
            unique_valid_signers.len()
        );

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = authority,
        space = 0,
        owner = system_program::ID,
        seeds = [b"treasury", vault.key().as_ref()],
        bump
    )]
    /// CHECK: Treasury PDA initialized as system-owned account with no data
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(
        seeds = [b"vault", vault.authority.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"treasury", vault.key().as_ref()],
        bump
    )]
    /// CHECK: Treasury PDA verified by seeds
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(ticket: WithdrawalTicket)]
pub struct WithdrawSol<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"treasury", vault.key().as_ref()],
        bump
    )]
    /// CHECK: Treasury PDA verified by seeds
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Recipient verified against ticket
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + NonceAccount::INIT_SPACE,
        seeds = [b"nonce", vault.key().as_ref(), &ticket.request_id.to_le_bytes()],
        bump
    )]
    pub nonce_account: Account<'info, NonceAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: instructions sysvar (used to inspect Ed25519 precompile instruction)
    #[account(address = sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey, // 32 - original creator (for PDA derivation)
    pub m_threshold: u8,   // 1  - M of N required
    #[max_len(MAX_SIGNERS)]
    pub signers: Vec<Pubkey>, // 4 + N*32 - authorized signers
    pub bump: u8,          // 1  - PDA bump
}

#[account]
#[derive(InitSpace)]
pub struct NonceAccount {
    pub used: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SignerWithSignature {
    pub pubkey: Pubkey,
    pub signature: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawalTicket {
    pub request_id: u64,
    pub vault: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub expiry: i64,     // Unix timestamp
    pub network_id: u64, // Solana mainnet=101, devnet=102, testnet=103
}

impl WithdrawalTicket {
    /// Compute hash for signing using Solana's native hash
    pub fn hash(&self) -> [u8; 32] {
        let mut data = Vec::new();

        // Domain separator
        data.extend_from_slice(DOMAIN_SEPARATOR.as_bytes());

        // Ticket fields
        data.extend_from_slice(&self.request_id.to_le_bytes());
        data.extend_from_slice(&self.vault.to_bytes());
        data.extend_from_slice(&self.recipient.to_bytes());
        data.extend_from_slice(&self.amount.to_le_bytes());
        data.extend_from_slice(&self.expiry.to_le_bytes());
        data.extend_from_slice(&self.network_id.to_le_bytes());

        hash(&data).to_bytes()
    }
}

/// Verify Ed25519 signature using Solana's syscall
fn verify_ed25519_signature_from_instructions(
    instructions_sysvar: &AccountInfo,
    message: &[u8; 32],
    signature: &[u8; 64],
    pubkey: &[u8; 32],
) -> Result<bool> {
    use solana_program::ed25519_program;
    use solana_program::sysvar::instructions::{load_instruction_at_checked, load_current_index_checked};

    // Get current instruction index
    let current_index = load_current_index_checked(instructions_sysvar)?;

    // Search backwards through instructions before the current one
    for i in 0..current_index {
        let ix = load_instruction_at_checked(i as usize, instructions_sysvar)?;

        // Check if this is an Ed25519 verification instruction
        if ix.program_id != ed25519_program::ID {
            continue;
        }

        // Parse the Ed25519 instruction data
        // Format: [num_signatures: u8, padding: u8, [signature_offset: u16, sig_ix_offset: u16, 
        //          pubkey_offset: u16, pubkey_ix_offset: u16, message_offset: u16, 
        //          message_size: u16, message_ix_offset: u16] * num_signatures, 
        //          padding to 16-byte alignment, signatures, pubkeys, messages]
        
        if ix.data.len() < 16 {
            continue;
        }

        let num_signatures = ix.data[0];
        if num_signatures == 0 {
            continue;
        }

        // For simplicity, we'll check the first signature entry
        // In production, you'd want to iterate through all signature entries
        
        let sig_offset = u16::from_le_bytes([ix.data[2], ix.data[3]]) as usize;
        let pubkey_offset = u16::from_le_bytes([ix.data[6], ix.data[7]]) as usize;
        let message_offset = u16::from_le_bytes([ix.data[10], ix.data[11]]) as usize;
        let message_size = u16::from_le_bytes([ix.data[12], ix.data[13]]) as usize;

        // Verify offsets are within bounds
        if sig_offset + 64 > ix.data.len() 
            || pubkey_offset + 32 > ix.data.len() 
            || message_offset + message_size > ix.data.len() {
            continue;
        }

        // Check if this instruction verifies our specific signature
        let ix_signature = &ix.data[sig_offset..sig_offset + 64];
        let ix_pubkey = &ix.data[pubkey_offset..pubkey_offset + 32];
        let ix_message = &ix.data[message_offset..message_offset + message_size];

        if ix_signature == signature 
            && ix_pubkey == pubkey 
            && ix_message == message {
            // Found a matching Ed25519 verification instruction
            // If we got here, the Ed25519 program already verified it successfully
            return Ok(true);
        }
    }

    // No matching Ed25519 instruction found
    Ok(false)
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid signers count")]
    InvalidSignersCount,
    #[msg("Invalid m_threshold")]
    InvalidThreshold,
    #[msg("Duplicate signer detected")]
    DuplicateSigner,
    #[msg("Not enough valid signatures from authorized signers")]
    InsufficientValidSignatures,
    #[msg("Account is not a signer")]
    AccountNotSigner,
    #[msg("Insufficient funds in treasury")]
    InsufficientFunds,
    #[msg("Invalid amount (must be > 0)")]
    InvalidAmount,
    #[msg("Treasury must be owned by system program")]
    InvalidTreasuryOwner,
    #[msg("Ticket has expired")]
    TicketExpired,
    #[msg("Nonce has already been used")]
    NonceAlreadyUsed,
    #[msg("Invalid vault in ticket")]
    InvalidVault,
    #[msg("Invalid recipient in ticket")]
    InvalidRecipient,
    #[msg("Insufficient signatures provided")]
    InsufficientSignatures,
    #[msg("Invalid Ed25519 signature")]
    InvalidSignature,
}
