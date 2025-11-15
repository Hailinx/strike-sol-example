# Strike Sol Smart Contract Demo

# Overview

A Solana program that securely manages user deposits and withdrawals using threshold signatures (M-of-N). It supports both native SOL and SPL tokens; and emits clear program logs for traceability.

# Design Motivation
- **Eliminate operational overhead**: no periodic “sweeps” or maintenance transactions needed to prepare funds for withdrawal.
- **Ensure immediate liquidity**: deposits are always directly usable for withdrawals without off-chain fund movements.
- **Maintain verifiable custody**: all user funds remain on-chain and withdrawable at any time.
- **Future-proof design**: supports adding on-chain withdrawal limits (per-user or global) without introducing manual processes.


# Functional Requirements

## 1. Deposit

- **Caller**: User
- **Inputs**:
    - Request ID
    - One or more assets (SOL and/or SPL token mints) with amounts
    - Optional metadata (ignored by the program)
- **Logic:**
    - Assets must be whitelisted (SOL or SPL mints).
    - No on-chain per-user accounting; the program only transfers and emits a log.
    - No need to verify Request ID uniqueness.
    - Deposited funds are **immediately available for withdrawal**, without requiring any off-chain aggregation or fund movement by the exchange.
- **Outputs:**
    - Emit a `Deposit` log containing the Request ID.


## 2. Withdraw

- **Caller:** User or Exchange
- **Inputs:**
    - A withdrawal ticket containing:
        - Request ID
        - Network ID
        - Recipient Address
        - One or more assets (SOL and/or SPL mints) with amounts
        - Deadline (Expiry Time)
    - Threshold signatures from Validators (M-of-N) on the whole tickets list
    - Optional metadata (ignored by the program)
- **Logic:**
    - Verify:
        - ~~Assets must be whitelisted (SOL or SPL mints).~~
        - The ticket must not be expired yet (Deadline < Block/Current Time).
        - Validator signatures (M-of-N threshold).
        - Sufficient **program-controlled on-chain balances** per asset.
        - Each Request ID is **globally unique** (cross-asset, cross-network).
        - Network must be the same.
    - Execute payouts and mark tickets as claimed.
    - **No “sweep” or intermediate fund collection is required**; withdrawals are paid directly from the program’s existing on-chain balances.
    - Users and exchanges must both present valid **threshold-signed withdrawal tickets**.
    - Withdrawals are **atomic** — all transfers succeed or the entire transaction reverts.
- **Outputs:**
    - Emit a `Withdraw` log with the Request ID for each withdrawal ticket.
    - ~~Logs must be emitted in execution order to preserve deterministic sequencing for off-chain indexers.~~


## 3. [Admin] Assets Management

- The program keeps a whitelist of allowed assets (SOL or SPL mints).
- Only these can be deposited or withdrawn.
- **Allow addition of new whitelisted assets** through an authorized instruction (e.g., admin or validator proposal).
- **Allow deletion of existing whitelisted assets** — once removed, new deposits are blocked, but withdrawals of already-held balances remain fully functional.
- An asset can be **completely deleted only after all balances have been fully withdrawn**, verified by **external governance** before deletion.
- Instructions to update and manage whitelisted assets safely without affecting user withdrawals.
- These admin actions must be signed / approved by **all active validators**.


## 4. [Admin] Validators Management

- Instructions to update or rotate validator public keys.
- Rotation replaces the active validator set; previously signed withdrawal tickets remain valid if signed under the current active set at execution time.
- These admin actions must be signed / approved by **all active validators**.


## 5. [Admin] Funds Management

- Functions for the exchange to deposit to and withdraw from the smart contracts to transfer/balance them across blockchains.
- Admin Deposit needs to be signed by at least one validator.
- Admin Withdraw needs to be signed by **almost** **all active validators**.

## 6. Withdrawal Limits

- Support optional global limit.
- Enforceable on-chain without requiring manual intervention.

# Non-Functional Requirements

## Upgradability
See [upgrade-guide](docs/upgrade-guide.md)

## Security

- Solana program security best practices.
- Enforce strict signature and Request ID validation (global uniqueness across assets and networks).
- Ensure atomic execution of withdrawals.
- Ensure **deterministic log ordering** for consistent off-chain indexing and auditability.


## Efficiency

- Optimize for compute units and account metas.
- **secp256k1** is used for signature scheme with compact signatures and signers’ public keys can be recovered from the signatures themselves (don’t need to pass signers’ keys in call data).
- Ensured **no periodic maintenance or program calls** are needed by the exchange to prepare balances for withdrawal (“no sweeping”).


## Future Enhancements

- Support **aggregated threshold signatures** (e.g., BLS, Schnorr/FROST) if/when practical on Solana to reduce signature payloads.
- Use Merkle/Patricia trees to store claimed ticket proofs efficiently.
- Add flexible withdrawal-limit modules configurable per asset or user tier.


# Design Consideration
See [design-consideration](docs/design-consideration.md)


# Development Guide

## Env
The network related env is maintained in .env.
Check the `src/client.ts` code for more details on how to use the client.

## Run unit test
```
npm install
anchor test
```

## Deploy and test with localnet
```
# Ensure set solana config to localnet
solana config set -ul

# Airdrop to wallet
solana airdrop <AMOUNT_OF_SOL>
solana airdrop <AMOUNT_OF_SOL> <ACCOUNT_PUBLIC_KEY>

# check balance
solana balance
solana balance <ACCOUNT_PUBLIC_KEY>

# Start local validator in one terminal
solana-test-validator

# Open another terminal, build and deploy the smart contract to local
anchor build
anchor deploy --provider.cluster localnet

# Update provider url in .env if needed
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899

# Run examples
npx tsx examples/simple_client.ts
npx tsx examples/simple_spl_client.ts
```