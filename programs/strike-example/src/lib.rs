use anchor_lang::prelude::*;

declare_id!("Aq18qW6eoU9ugFtUBcsknFzXpaTapfPL1vSNrxLEieBm");

const MAX_NUMBER_SIGNERS: usize = 10; // N

#[program]
pub mod strike_example {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        m_threshold: u8,
        signers: Vec<Pubkey>,
    ) -> Result<()> {
        require!(m_threshold > 0, ErrorCode::InvalidThreshold);
        require!(
            (m_threshold as usize) <= signers.len(),
            ErrorCode::ThresholdExceedsSigners
        );
        require!(
            signers.len() <= MAX_NUMBER_SIGNERS,
            ErrorCode::TooManySigners
        );

        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.m_threshold = m_threshold;
        vault.signers = signers.clone();
        vault.nonce = 0;
        vault.bump = ctx.bumps.vault;

        msg!(
            "Vault initialized: m={}, n={}, authority={}",
            m_threshold,
            signers.len(),
            vault.authority
        );

        Ok(())
    }

    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.user.key(),
            &ctx.accounts.vault.key(),
            amount,
        );

        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.vault.to_account_info(),
            ],
        )?;

        msg!(
            "SOL Deposit: user={}, amount={}, vault_balance={}",
            ctx.accounts.user.key(),
            amount,
            ctx.accounts.vault.to_account_info().lamports()
        );

        Ok(())
    }

    pub fn withdraw_sol(
        ctx: Context<WithdrawSol>,
        amount: u64,
        withdrawal_id: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let vault = &mut ctx.accounts.vault;

        let provided_signers: Vec<Pubkey> = ctx
            .remaining_accounts
            .iter()
            .filter(|acc| acc.is_signer)
            .map(|acc| acc.key())
            .collect();

        require!(
            provided_signers.len() >= vault.m_threshold as usize,
            ErrorCode::InsufficientSigners
        );

        // Verify all signers are authorized
        for signer in &provided_signers {
            require!(
                vault.signers.contains(signer),
                ErrorCode::UnauthorizedSigner
            );
        }

        // Ensure vault has sufficient balance (accounting for rent)
        let vault_balance = vault.to_account_info().lamports();
        let rent_exempt_minimum = Rent::get()?.minimum_balance(vault.to_account_info().data_len());

        require!(
            vault_balance >= amount + rent_exempt_minimum,
            ErrorCode::InsufficientFunds
        );

        // Transfer lamports directly (works with PDAs that have data)
        **vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? += amount;

        msg!(
            "SOL Withdrawal: id={}, recipient={}, amount={}, signers={}, vault_balance={}",
            withdrawal_id,
            ctx.accounts.recipient.key(),
            amount,
            provided_signers.len(),
            ctx.accounts.vault.to_account_info().lamports()
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

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: Recipient can be any account
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey, // 32
    pub m_threshold: u8,   // 1
    #[max_len(MAX_NUMBER_SIGNERS)]
    pub signers: Vec<Pubkey>, // 4 + (N * 32)
    pub nonce: u64,        // 8
    pub bump: u8,          // 1
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid threshold value")]
    InvalidThreshold,
    #[msg("Threshold exceeds number of signers")]
    ThresholdExceedsSigners,
    #[msg("Too many signers")]
    TooManySigners,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Insufficient signers provided")]
    InsufficientSigners,
    #[msg("Unauthorized signer")]
    UnauthorizedSigner,
    #[msg("Insufficient funds in vault")]
    InsufficientFunds,
}
