use anchor_lang::prelude::*;

declare_id!("Aq18qW6eoU9ugFtUBcsknFzXpaTapfPL1vSNrxLEieBm");

const MAX_SIGNERS: usize = 10; // N

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

    pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64, withdrawal_id: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let vault = &mut ctx.accounts.vault;

        // Validate treasury is system-owned
        require!(
            ctx.accounts.treasury.owner == &system_program::ID,
            ErrorCode::InvalidTreasuryOwner
        );

        // Ensure M of N valid signers.
        let mut unique_valid_signers = std::collections::HashSet::new();
        for signer_account in ctx.remaining_accounts.iter() {
            require!(signer_account.is_signer, ErrorCode::AccountNotSigner);

            if vault.signers.contains(signer_account.key) {
                unique_valid_signers.insert(signer_account.key());
            }
        }
        require!(
            unique_valid_signers.len() >= vault.m_threshold as usize,
            ErrorCode::InsufficientValidSignatures
        );

        // Ensure vault has sufficient balance (accounting for rent)
        let treasury_balance = ctx.accounts.treasury.lamports();
        let rent_exempt_minimum: u64 =
            Rent::get()?.minimum_balance(ctx.accounts.treasury.to_account_info().data_len());
        let available = treasury_balance.saturating_sub(rent_exempt_minimum);

        require!(available >= amount, ErrorCode::InsufficientFunds);

        // Transfer lamports directly (works with PDAs that have data)
        let vault_key = vault.key();
        let seeds = &[b"treasury", vault_key.as_ref(), &[ctx.bumps.treasury]];
        let signer_seeds = &[&seeds[..]];

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.treasury.key(),
            &ctx.accounts.recipient.key(),
            amount,
        );

        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.recipient.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        // **ctx.accounts.treasury.try_borrow_mut_lamports()? -= amount;
        // **ctx.accounts.recipient.try_borrow_mut_lamports()? += amount;

        msg!(
            "SOL Withdrawal: id={}, recipient={}, amount={}, signers={}, treasury_balance={}",
            withdrawal_id,
            ctx.accounts.recipient.key(),
            amount,
            ctx.remaining_accounts.len(),
            ctx.accounts.treasury.lamports()
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
pub struct WithdrawSol<'info> {
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

    /// CHECK: Recipient can be any account
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: M signers who must sign this transaction
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
}
