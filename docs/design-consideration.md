# Design Consideration

## 1. System PDA as Treasury Account

### Design Choice
The treasury account is implemented as a **System Program-owned PDA** (Program Derived Address) with zero data space, rather than a program-owned account.

### Rationale
- **Native SOL handling**: System-owned accounts can receive and hold SOL transfers naturally without requiring the program to implement custom SOL handling logic
- **Simpler architecture**: Leverages Solana's native account model for SOL custody instead of creating a wrapper account
- **Gas efficiency**: Eliminates the need for wrapping/unwrapping operations when handling native SOL
- **Standard compliance**: Follows Solana's recommended pattern for holding native SOL in program-controlled accounts

### Derivation
```rust
seeds = [b"treasury", vault.key().as_ref()]
```
The treasury PDA is derived from the vault account's public key, ensuring a unique treasury for each vault instance.

### Trade-offs

**Pros:**
- Direct SOL transfers without intermediate accounts
- Lower compute unit consumption for SOL operations
- Cleaner separation between vault configuration (program-owned) and funds custody (system-owned)
- Reduced attack surface by using battle-tested System Program

**Cons:**
- Requires `UncheckedAccount` type with manual validation (though mitigated by PDA derivation)
- Cannot store additional metadata directly in the treasury account (metadata stays in the vault account)
- Less intuitive for developers unfamiliar with system-owned PDAs

### Alternatives Considered
1. **Program-owned account with data**: Would require custom SOL wrapping logic and increase complexity
2. **Associated Token Account for wrapped SOL**: Adds unnecessary wrapping/unwrapping overhead and user confusion

## 2. Vault Seed for PDA Derivation

### Design Choice
The vault PDA uses a **user-provided string seed** (`vault_seed`) instead of the authority's public key for derivation.

### Rationale
- **Multi-vault support**: A single authority can create and manage multiple independent vaults by using different seeds
- **Flexible authority management**: Authority can be transferred or updated without affecting the vault's identity or address
- **Deterministic addressing**: External systems can compute vault addresses knowing only the seed, without querying on-chain state
- **Separation of concerns**: Vault identity (determined by seed) is independent from vault governance (determined by authority)

### Derivation
```rust
seeds = [b"vault", vault_seed.as_bytes()]
```

### Trade-offs

**Pros:**
- **Scalability**: One authority can operate multiple vaults for different purposes (e.g., different networks, asset pools, risk tiers)
- **Future-proof**: Enables authority rotation without migrating funds or changing vault addresses
- **Predictability**: Vault addresses are deterministic and can be computed off-chain before initialization
- **Namespace control**: The authority controls which seeds to use, preventing namespace collisions
- **Authority Rotation**: The vault_seed makes the pda address independent with the authority pubkey. Makes rotating the authority possible.

**Cons:**
- **Seed management**: Users must track and remember their vault seeds (mitigated by using descriptive names)
- **No automatic authority-vault binding**: Less discoverable than authority-based derivation (requires off-chain indexing)
- **Seed collision risk**: Users must ensure seed uniqueness across their intended use cases

### Alternatives

**Authority pubkey as seed**:
```rust
   seeds = [b"vault", authority.key().as_ref()]
```
   - **Pro**: Automatic 1:1 mapping between authority and vault
   - **Con**: Limits each authority to a single vault, requires new authority keypairs for multiple vaults
   - **Con**: Cannot transfer authority without migrating the entire vault
