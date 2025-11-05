use anchor_lang::prelude::*;

use super::constant::*;
use super::models::Asset;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey, // 32 - original creator (for PDA derivation)
    pub m_threshold: u8,   // 1  - M of N required
    #[max_len(MAX_SIGNERS)]
    pub signers: Vec<[u8; 20]>, // 4 + N*20 - Ethereum addresses of authorized signers
    #[max_len(MAX_ASSETS)]
    pub whitelisted_assets: Vec<Asset>,
    pub bump: u8, // 1  - PDA bump
}

#[account]
#[derive(InitSpace)]
pub struct NonceAccount {
    pub used: bool,
}
