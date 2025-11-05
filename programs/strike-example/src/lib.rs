use anchor_lang::prelude::*;
use solana_program::secp256k1_recover::secp256k1_recover;
use solana_program::keccak;

declare_id!("Aq18qW6eoU9ugFtUBcsknFzXpaTapfPL1vSNrxLEieBm");

const MAX_SIGNERS: usize = 10; // N
const DOMAIN_SEPARATOR: &str = "strike-protocol-v1";

#[program]
pub mod strike_example {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        m_threshold: u8,
        signers: Vec<[u8; 20]>, // Ethereum addresses (20 bytes)
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

        // 5. Compute message hash (Ethereum compatible - keccak256)
        let message_hash = ticket.hash();

        // 6. Verify M-of-N secp256k1 signatures using recovery
        let mut unique_valid_signers = std::collections::HashSet::new();

        for signer_sig in signers_with_sigs.iter() {
            // Verify this is an authorized signer
            if !vault.signers.contains(&signer_sig.eth_address) {
                continue;
            }

            // Recover the public key from the signature
            match recover_eth_address(&message_hash, &signer_sig.signature, signer_sig.recovery_id)
            {
                Ok(recovered_address) => {
                    // Check if recovered address matches the claimed signer
                    if recovered_address == signer_sig.eth_address {
                        unique_valid_signers.insert(signer_sig.eth_address);
                    }
                }
                Err(_) => {
                    continue;
                }
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
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,     // 32 - original creator (for PDA derivation)
    pub m_threshold: u8,       // 1  - M of N required
    #[max_len(MAX_SIGNERS)]
    pub signers: Vec<[u8; 20]>, // 4 + N*20 - Ethereum addresses of authorized signers
    pub bump: u8,              // 1  - PDA bump
}

#[account]
#[derive(InitSpace)]
pub struct NonceAccount {
    pub used: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SignerWithSignature {
    pub eth_address: [u8; 20], // Ethereum address of the signer
    pub signature: [u8; 64],   // r and s components (32 bytes each)
    pub recovery_id: u8,       // v component (0, 1, 27, or 28)
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
    /// Compute keccak256 hash for signing (Ethereum compatible)
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

        // Use keccak256 for Ethereum compatibility
        let hash_result = keccak::hash(&data);
        hash_result.to_bytes()
    }
}

/// Recover Ethereum address from signature using secp256k1_recover syscall
fn recover_eth_address(
    message_hash: &[u8; 32],
    signature: &[u8; 64],
    recovery_id: u8,
) -> Result<[u8; 20]> {
    // Normalize recovery_id: Ethereum uses 27/28, but syscall expects 0/1
    let normalized_recovery_id = match recovery_id {
        0 | 1 => recovery_id,
        27 | 28 => recovery_id - 27,
        _ => return err!(ErrorCode::InvalidRecoveryId),
    };

    // Recover the 64-byte public key from the signature
    let recovered_pubkey = secp256k1_recover(message_hash, normalized_recovery_id, signature)
        .map_err(|_| ErrorCode::InvalidSignature)?;

    // Derive Ethereum address: keccak256(pubkey)[12..32]
    let pubkey_hash = keccak::hash(&recovered_pubkey.to_bytes());
    let hash_bytes = pubkey_hash.to_bytes();

    let mut eth_address = [0u8; 20];
    eth_address.copy_from_slice(&hash_bytes[12..32]);

    Ok(eth_address)
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
    #[msg("Invalid secp256k1 signature")]
    InvalidSignature,
    #[msg("Invalid recovery ID (must be 0, 1, 27, or 28)")]
    InvalidRecoveryId,
}