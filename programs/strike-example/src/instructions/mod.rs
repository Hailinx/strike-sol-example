pub mod accounts;
pub mod deposit;
pub mod initialize;
pub mod withdraw;

pub mod models;
pub mod util;

pub use accounts::*;
pub use deposit::*;
pub use initialize::*;
pub use models::*;
pub use withdraw::*;

pub mod constant {
    pub const MAX_SIGNERS: usize = 10; // N
    pub const MAX_ASSETS: usize = 20;
    pub const DOMAIN_SEPARATOR: &str = "strike-protocol-v1";
}

pub mod errors {
    use anchor_lang::prelude::*;

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
}
