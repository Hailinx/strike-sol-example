use anchor_lang::prelude::*;
use solana_program::keccak;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub enum Asset {
    Sol,
    SplToken { mint: Pubkey },
}

impl Asset {
    fn add_to_data(&self, data: &mut Vec<u8>) {
        match &self {
            Asset::Sol => {
                data.push(0u8);
            }
            Asset::SplToken { mint } => {
                data.push(1u8);
                data.extend_from_slice(&mint.to_bytes());
            }
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AssetAmount {
    pub asset: Asset,
    pub amount: u64,
}

impl AssetAmount {
    fn add_to_data(&self, data: &mut Vec<u8>) {
        self.asset.add_to_data(data);
        data.push(64u8);
        data.extend_from_slice(&self.amount.to_le_bytes());
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SignerWithSignature {
    pub signature: [u8; 64], // r and s components (32 bytes each)
    pub recovery_id: u8,     // v component (0, 1, 27, or 28)
}

pub trait Ticket {
    fn separator(&self) -> &'static str;
    fn hash(&self) -> [u8; 32];
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AddAssetTicket {
    pub request_id: u64,
    pub vault: Pubkey,
    pub asset: Asset,
    pub expiry: i64,
    pub network_id: u64,
}

impl Ticket for AddAssetTicket {
    fn separator(&self) -> &'static str {
        "strike-protocol-v1-AddAsset"
    }

    fn hash(&self) -> [u8; 32] {
        hash_asset_ticket(
            self.separator(),
            self.request_id,
            &self.vault,
            &self.asset,
            self.expiry,
            self.network_id,
        )
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RemoveAssetTicket {
    pub request_id: u64,
    pub vault: Pubkey,
    pub asset: Asset,
    pub expiry: i64,
    pub network_id: u64,
}

impl Ticket for RemoveAssetTicket {
    fn separator(&self) -> &'static str {
        "strike-protocol-v1-RemoveAsset"
    }

    fn hash(&self) -> [u8; 32] {
        hash_asset_ticket(
            self.separator(),
            self.request_id,
            &self.vault,
            &self.asset,
            self.expiry,
            self.network_id,
        )
    }
}

fn hash_asset_ticket(
    separator: &str,
    request_id: u64,
    vault: &Pubkey,
    asset: &Asset,
    expiry: i64,
    network_id: u64,
) -> [u8; 32] {
    let mut data = Vec::new();
    data.extend_from_slice(separator.as_bytes());

    // Ticket fields
    data.extend_from_slice(&request_id.to_le_bytes());
    data.extend_from_slice(&vault.to_bytes());
    data.extend_from_slice(&expiry.to_le_bytes());
    data.extend_from_slice(&network_id.to_le_bytes());
    asset.add_to_data(&mut data);

    let hash_result = keccak::hash(&data);
    hash_result.to_bytes()
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RotateValidatorTicket {
    pub request_id: u64,
    pub vault: Pubkey,
    pub signers: Vec<[u8; 20]>,
    pub m_threshold: u8,
    pub expiry: i64,
    pub network_id: u64,
}

impl Ticket for RotateValidatorTicket {
    fn separator(&self) -> &'static str {
        "strike-protocol-v1-rotate"
    }

    fn hash(&self) -> [u8; 32] {
        let mut data = Vec::new();
        data.extend_from_slice(self.separator().as_bytes());

        // Ticket fields
        data.extend_from_slice(&self.request_id.to_le_bytes());
        data.extend_from_slice(&self.vault.to_bytes());
        for signer in self.signers.iter() {
            data.push(55u8);
            data.extend_from_slice(signer);
            data.push(56u8);
        }
        data.extend_from_slice(&self.m_threshold.to_le_bytes());
        data.extend_from_slice(&self.expiry.to_le_bytes());
        data.extend_from_slice(&self.network_id.to_le_bytes());

        let hash_result = keccak::hash(&data);
        hash_result.to_bytes()
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AdminDepositTicket {
    pub request_id: u64,
    pub vault: Pubkey,
    pub user: Pubkey,
    pub deposits: Vec<AssetAmount>,
    pub expiry: i64,     // Unix timestamp
    pub network_id: u64, // Solana mainnet=101, devnet=102, testnet=103
}

impl Ticket for AdminDepositTicket {
    fn separator(&self) -> &'static str {
        "strike-protocol-v1-AdminDeposit"
    }

    fn hash(&self) -> [u8; 32] {
        let mut data = Vec::new();
        data.extend_from_slice(self.separator().as_bytes());

        // Ticket fields
        data.extend_from_slice(&self.request_id.to_le_bytes());
        data.extend_from_slice(&self.vault.to_bytes());
        data.extend_from_slice(&self.user.to_bytes());
        for asset_amount in self.deposits.iter() {
            asset_amount.add_to_data(&mut data);
        }
        data.extend_from_slice(&self.expiry.to_le_bytes());
        data.extend_from_slice(&self.network_id.to_le_bytes());

        let hash_result = keccak::hash(&data);
        hash_result.to_bytes()
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawalTicket {
    pub request_id: u64,
    pub vault: Pubkey,
    pub recipient: Pubkey,
    pub withdrawals: Vec<AssetAmount>,
    pub expiry: i64,     // Unix timestamp
    pub network_id: u64, // Solana mainnet=101, devnet=102, testnet=103
}

impl Ticket for WithdrawalTicket {
    fn separator(&self) -> &'static str {
        "strike-protocol-v1-Withdrawal"
    }

    fn hash(&self) -> [u8; 32] {
        let mut data = Vec::new();
        data.extend_from_slice(self.separator().as_bytes());

        // Ticket fields
        data.extend_from_slice(&self.request_id.to_le_bytes());
        data.extend_from_slice(&self.vault.to_bytes());
        data.extend_from_slice(&self.recipient.to_bytes());
        for asset_amount in self.withdrawals.iter() {
            asset_amount.add_to_data(&mut data);
        }
        data.extend_from_slice(&self.expiry.to_le_bytes());
        data.extend_from_slice(&self.network_id.to_le_bytes());

        let hash_result = keccak::hash(&data);
        hash_result.to_bytes()
    }
}
