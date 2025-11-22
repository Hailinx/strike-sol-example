use std::collections::HashMap;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use super::accounts::*;
use super::errors::ErrorCode;
use super::models::*;
use super::constant::*;
use super::util::{check_duplicate_assets, validate_sigs};

pub fn bulk_withdraw<'info>(
    ctx: Context<'_, '_, 'info, 'info, BulkWithdraw<'info>>,
    bulk_ticket: BulkWithdrawalTicket,
    signers_with_sigs: Vec<SignerWithSignature>,
    metadata: Option<String>,
) -> Result<()> {
    require!(
        !bulk_ticket.tickets.is_empty(),
        ErrorCode::NoWithdrawalsProvided
    );
    require!(
        bulk_ticket.tickets.len() <= MAX_BULK_TICKETS,
        ErrorCode::TooManyTickets
    );

    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();
    let clock = Clock::get()?;
    let num_tickets = bulk_ticket.tickets.len();

    // Must provide nonce accounts in remaining_accounts.
    require!(
        ctx.remaining_accounts.len() >= num_tickets,
        ErrorCode::InsufficientAccounts
    );

    // Check request id has no duplication.
    let mut seen_request_ids = std::collections::HashSet::new();
    for ticket in bulk_ticket.tickets.iter() {
        require!(
            seen_request_ids.insert(ticket.request_id),
            ErrorCode::DuplicateRequestId
        );
    }

    require!(
        signers_with_sigs.len() >= vault.m_threshold as usize,
        ErrorCode::InsufficientSignatures
    );

    // Validate the signatures.
    let validated_sigs = validate_sigs(&bulk_ticket, &signers_with_sigs, &vault.signers);
    require!(
        validated_sigs.len() >= vault.m_threshold as usize,
        ErrorCode::InsufficientValidSignatures
    );

    // Calculate facts.
    let rent = Rent::get()?;
    let nonce_space = 8 + NonceAccount::INIT_SPACE;
    let nonce_rent = rent.minimum_balance(nonce_space);

    let treasury_balance = ctx.accounts.treasury.lamports();
    let rent_exempt_minimum =
        rent.minimum_balance(ctx.accounts.treasury.to_account_info().data_len());
    let treasury_available = treasury_balance.saturating_sub(rent_exempt_minimum);

    let mut total_sol_withdrawals = 0u64;
    let mut total_spl_withdrawals = HashMap::<Pubkey, u64>::new();

    // Sol recipient accounts from remaining_accounts. Index by ticket index.
    let mut recipient_accounts = Vec::<&AccountInfo<'info>>::new();
    // Vault token accounts from remaining_accounts. Key by mint.
    let mut vault_token_accounts = HashMap::<Pubkey, Account<'info, TokenAccount>>::new();
    // Spl recipient accounts from remaining_accounts. Index by ticket index. Inner map key by mint.
    let mut recipient_token_accounts = Vec::<HashMap<Pubkey, Account<'info, TokenAccount>>>::new();

    // Step 1: Validating all tickets and nonce accounts.
    for (idx, ticket) in bulk_ticket.tickets.iter().enumerate() {
        require!(
            !ticket.withdrawals.is_empty(),
            ErrorCode::NoWithdrawalsProvided
        );

        require!(ticket.vault == vault.key(), ErrorCode::InvalidVault);
        require!(
            vault.network_id == ticket.network_id,
            ErrorCode::InvalidNetwork
        );
        require!(
            clock.unix_timestamp <= ticket.expiry,
            ErrorCode::TicketExpired
        );

        check_duplicate_assets(&ticket.withdrawals)?;

        // Get nonce account from remaining_accounts
        let nonce_account_info = &ctx.remaining_accounts[idx];
        let nonce_seeds = &[
            b"nonce",
            vault_key.as_ref(),
            &ticket.request_id.to_le_bytes(),
        ];
        let (expected_nonce_pda, _) = Pubkey::find_program_address(nonce_seeds, ctx.program_id);

        require!(
            nonce_account_info.key() == expected_nonce_pda,
            ErrorCode::InvalidNonceAccount
        );

        // Check if nonce already exists and whether used.
        // Nonce_data length is fixed to be 9 bytes (8 + 1 bool).
        // If account is empty, it will be created in Step 2.
        if !nonce_account_info.data_is_empty() {
            let nonce_data = nonce_account_info.try_borrow_data()?;
            require!(nonce_data.len() == 9, ErrorCode::InvalidNonceAccount);
            let nonce_used = nonce_data[8] != 0;
            require!(!nonce_used, ErrorCode::NonceAlreadyUsed);
        }

        // Verify recipient account exactly one.
        let recipient_infos: Vec<&AccountInfo<'info>> = ctx
            .remaining_accounts
            .iter()
            .skip(num_tickets)
            .filter(|acc| acc.key() == ticket.recipient)
            .collect();
        require!(recipient_infos.len() == 1, ErrorCode::InvalidRecipient);

        let recipient_info = recipient_infos[0];
        recipient_accounts.push(recipient_info);

        let mut recipient_token_accounts_by_mint = HashMap::new();

        // Validate withdrawals under the ticket.
        for withdrawal in ticket.withdrawals.iter() {
            require!(withdrawal.amount > 0, ErrorCode::InvalidAmount);

            match withdrawal.asset {
                Asset::Sol => {
                    require!(
                        treasury_available >= withdrawal.amount,
                        ErrorCode::InsufficientFunds
                    );

                    total_sol_withdrawals = total_sol_withdrawals
                        .checked_add(withdrawal.amount)
                        .ok_or(ErrorCode::Overflow)?;
                }
                Asset::SplToken { mint } => {
                    let mut recipient_token_account: Option<Account<'info, TokenAccount>> = None;
                    let mut vault_token_account: Option<Account<'info, TokenAccount>> = None;

                    for acc in ctx.remaining_accounts.iter() {
                        if let Ok(token_acc) = Account::<TokenAccount>::try_from(acc) {
                            if token_acc.mint == mint {
                                // Ensure no duplicate in recipient_token_account and vault_token_account for a given mint.
                                if token_acc.owner == ticket.recipient.key() {
                                    require!(
                                        recipient_token_account.is_none(),
                                        ErrorCode::UnexpectedTokenAccounts
                                    );
                                    recipient_token_account = Some(token_acc);
                                } else if token_acc.owner == vault.key() {
                                    require!(
                                        vault_token_account.is_none(),
                                        ErrorCode::UnexpectedTokenAccounts
                                    );
                                    vault_token_account = Some(token_acc);
                                }
                            }
                        }
                    }

                    let vault_token = vault_token_account.ok_or(ErrorCode::TokenAccountNotFound)?;
                    let recipient_token =
                        recipient_token_account.ok_or(ErrorCode::TokenAccountNotFound)?;

                    require!(
                        vault_token.amount >= withdrawal.amount,
                        ErrorCode::InsufficientFunds
                    );

                    *total_spl_withdrawals.entry(mint).or_insert(0) = total_spl_withdrawals
                        .get(&mint)
                        .unwrap_or(&0)
                        .checked_add(withdrawal.amount)
                        .ok_or(ErrorCode::Overflow)?;

                    recipient_token_accounts_by_mint.insert(mint, recipient_token);
                    if !vault_token_accounts.contains_key(&mint) {
                        vault_token_accounts.insert(mint, vault_token);
                    }
                }
            }
        }

        recipient_token_accounts.push(recipient_token_accounts_by_mint);
    }

    // Check the total won't exceed the balance.
    require!(
        treasury_available >= total_sol_withdrawals,
        ErrorCode::InsufficientFunds
    );
    for (mint, total) in total_spl_withdrawals.iter() {
        let vault_token = vault_token_accounts
            .get(mint)
            .ok_or(ErrorCode::TokenAccountNotFound)?;
        require!(&vault_token.amount >= total, ErrorCode::InsufficientFunds);
    }

    // Step 2: Creating and initializing nonce accounts
    for (idx, ticket) in bulk_ticket.tickets.iter().enumerate() {
        let nonce_account_info = &ctx.remaining_accounts[idx];
        if !nonce_account_info.data_is_empty() {
            continue;
        }

        let nonce_seeds = &[
            b"nonce",
            vault_key.as_ref(),
            &ticket.request_id.to_le_bytes(),
        ];
        let (_, nonce_bump) = Pubkey::find_program_address(nonce_seeds, ctx.program_id);

        let nonce_signer_seeds: &[&[u8]] = &[
            b"nonce",
            vault_key.as_ref(),
            &ticket.request_id.to_le_bytes(),
            &[nonce_bump],
        ];

        // Create account
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: nonce_account_info.clone(),
                },
                &[nonce_signer_seeds],
            ),
            nonce_rent,
            nonce_space as u64,
            ctx.program_id,
        )?;

        let mut nonce_data = nonce_account_info.try_borrow_mut_data()?;
        nonce_data[0..8].copy_from_slice(NonceAccount::DISCRIMINATOR);
        nonce_data[8] = 0;
    }

    // Step 3: Executing transfer
    for (transfer_idx, ticket) in bulk_ticket.tickets.iter().enumerate() {
        let recipient_info = recipient_accounts
            .get(transfer_idx)
            .ok_or(ErrorCode::InvalidRecipient)?;

        // Mark nonce as used BEFORE transfer
        let nonce_account_info = &ctx.remaining_accounts[transfer_idx];
        let mut nonce_data = nonce_account_info.try_borrow_mut_data()?;
        nonce_data[8] = 1;

        for (withdrawal_idx, withdrawal) in ticket.withdrawals.iter().enumerate() {
            match &withdrawal.asset {
                Asset::Sol => {
                    ctx.accounts
                        .treasury
                        .lamports()
                        .checked_sub(withdrawal.amount)
                        .ok_or(ErrorCode::Overflow)?;
                    recipient_info
                        .lamports()
                        .checked_add(withdrawal.amount)
                        .ok_or(ErrorCode::Overflow)?;

                    **ctx.accounts.treasury.try_borrow_mut_lamports()? -= withdrawal.amount;
                    **recipient_info.try_borrow_mut_lamports()? += withdrawal.amount;

                    msg!(
                        "Bulk Withdrawal SOL [ticket {}, withdrawal {}]: request_id={}, recipient={}, amount={}, valid_signers={}, metadata={:?}",
                        transfer_idx,
                        withdrawal_idx,
                        ticket.request_id,
                        ticket.recipient,
                        withdrawal.amount,
                        validated_sigs.len(),
                        metadata,
                    );
                }
                Asset::SplToken { mint } => {
                    let recipient_token_accounts_by_mint = recipient_token_accounts
                        .get(transfer_idx)
                        .ok_or(ErrorCode::TokenAccountNotFound)?;
                    let recipient_token = recipient_token_accounts_by_mint
                        .get(&mint)
                        .ok_or(ErrorCode::TokenAccountNotFound)?;
                    let vault_token = vault_token_accounts
                        .get_mut(&mint)
                        .ok_or(ErrorCode::TokenAccountNotFound)?;

                    let seeds = &[b"vault", vault.vault_seed.as_bytes(), &[vault.bump]];
                    let signer_seeds = &[&seeds[..]];

                    let cpi_accounts = Transfer {
                        from: vault_token.to_account_info(),
                        to: recipient_token.to_account_info(),
                        authority: vault.to_account_info(),
                    };
                    let cpi_program = ctx.accounts.token_program.to_account_info();
                    let cpi_ctx =
                        CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

                    token::transfer(cpi_ctx, withdrawal.amount)?;
                    vault_token.reload()?;

                    msg!(
                        "Bulk Withdraw SPL Token [ticket {}, withdrawal {}]: request_id={}, mint={}, recipient={}, amount={}, valid_signers={}",
                        transfer_idx,
                        withdrawal_idx,
                        ticket.request_id,
                        mint,
                        ticket.recipient,
                        withdrawal.amount,
                        validated_sigs.len(),
                    );
                }
            }
        }
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(bulk_ticket: BulkWithdrawalTicket)]
pub struct BulkWithdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.vault_seed.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"treasury", vault.key().as_ref()],
        bump = vault.treasury_bump
    )]
    /// CHECK: Treasury PDA verified by seeds
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}
