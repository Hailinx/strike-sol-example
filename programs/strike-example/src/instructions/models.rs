use anchor_lang::prelude::*;
use solana_program::keccak;

use super::constant::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub enum Asset {
    Sol,
    SplToken { mint: Pubkey },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AssetAmount {
    pub asset: Asset,
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SignerWithSignature {
    pub signature: [u8; 64], // r and s components (32 bytes each)
    pub recovery_id: u8,     // v component (0, 1, 27, or 28)
}

pub trait Ticket {
    fn hash(&self) -> [u8; 32];
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AddAssetTicket {
    pub request_id: u64,
    pub vault: Pubkey,
    pub asset: Asset,
}

// impl Ticket for AddAssetTicket {
//     fn hash(&self) -> [u8; 32] {
//         let mut data = Vec::new();

//         // Domain separator
//         data.extend_from_slice(DOMAIN_SEPARATOR.as_bytes());

//     }
// }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawalTicket {
    pub request_id: u64,
    pub vault: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub expiry: i64,     // Unix timestamp
    pub network_id: u64, // Solana mainnet=101, devnet=102, testnet=103
}

impl Ticket for WithdrawalTicket {
    fn hash(&self) -> [u8; 32] {
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
