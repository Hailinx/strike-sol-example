# Strike Sol Smart Contract Demo


## Test local
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

# Open another terminal, deploy the smart contract to local
anchor deploy --provider.cluster localnet

# Update provider url: ANCHOR_PROVIDER_URL=http://127.0.0.1:8899

# Run example
npx tsx examples/simple_client.ts
```