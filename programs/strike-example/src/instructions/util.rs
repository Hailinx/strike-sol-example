use std::collections::HashSet;

use anchor_lang::prelude::*;
use solana_program::keccak;
use solana_program::secp256k1_recover::secp256k1_recover;

use super::errors::ErrorCode;
use super::models::*;
use super::models::{SignerWithSignature, Ticket};

pub fn check_duplicate_assets(list: &[AssetAmount]) -> Result<()> {
    let mut seen: HashSet<&Asset> = HashSet::new();
    for aa in list {
        require!(seen.insert(&aa.asset), ErrorCode::DuplicateAsset);
    }
    Ok(())
}

pub fn validate_sigs(
    ticket: &dyn Ticket,
    signers_with_sigs: &Vec<SignerWithSignature>,
    real_signers: &Vec<[u8; 20]>,
) -> HashSet<[u8; 20]> {
    let message_hash = ticket.hash();

    let mut valid_signers = HashSet::new();
    for signer_sig in signers_with_sigs.iter() {
        match recover_eth_address(&message_hash, &signer_sig.signature, signer_sig.recovery_id) {
            Ok(recovered_address) => {
                if real_signers.contains(&recovered_address) {
                    valid_signers.insert(recovered_address);
                }
            }
            Err(_) => continue,
        }
    }

    valid_signers
}

/// Recover Ethereum address from signature using secp256k1_recover syscall
pub fn recover_eth_address(
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
