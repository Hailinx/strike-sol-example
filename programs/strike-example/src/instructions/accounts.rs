use anchor_lang::prelude::*;

use super::constant::*;
use super::models::Asset;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub version: u8,
    pub authority: Pubkey,
    #[max_len(32)]
    pub vault_seed: String, // 32 - for PDA derivation
    pub m_threshold: u8,
    pub admin_threshold: u8,
    pub network_id: u64,
    #[max_len(MAX_SIGNERS)]
    pub signers: Vec<[u8; 20]>, // 4 + N*20 - Ethereum addresses of authorized signers
    #[max_len(MAX_ASSETS)]
    pub whitelisted_assets: Vec<Asset>,
    pub bump: u8,          // 1 - PDA bump
    pub treasury_bump: u8, // 1 - Treasury PDA bump
    pub reserve: [u8; 64], // reserve 64 bits for this version. Update the limit according to your need.
}

#[account]
#[derive(InitSpace)]
pub struct NonceAccount {
    pub used: bool,
}
