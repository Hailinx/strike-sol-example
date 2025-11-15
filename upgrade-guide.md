# Upgrade & Migration Guidelines


## 1. High-level upgrade flow

1. Implement new program code with:
    - `version` field in persistent accounts,
    - `migrate` instruction (idempotent, permissioned),
    - `version` checks in other instructions.
2. `anchor build --verifiable` and record the build hash.
3. Upgrade the program binary (via multisig / upgrade authority).
4. After binary upgrade, call the on-chain migrate instruction (signed by vault.authority / multisig).
5. Run post-upgrade smoke tests. If OK, announce and continue; if not, follow rollback/investigation plan.

## 2. Why migrate is explicit
- The Solana upgrade loader swaps the binary but does not run your business logic.
- `migrate` must be a separate instruction so you can:
    - check permissions on-chain,
    - perform idempotent data transforms,
    - be executed by multisig/governance flows,
    - audit and roll back if needed.

## 3. State versioning pattern
- Reserve padding bytes for future fields: reserved: [u8; N].
- On initialization: set version = 1.
- New incompatible state changes increment major version; additive changes can increment minor or leave major same.
- Every instruction that depends on new fields should check vault.version and fail fast if not migrated.

Example snippet (conceptual):
```
pub struct Vault {
  pub version: u8,
  pub authority: Pubkey,
  // ... other fields ...
  pub reserved: [u8; 64],
}

const CURRENT_VERSION: u8 = 2;
fn require_version(v: &Vault, min: u8) -> Result<()> {
  require!(v.version >= min, ErrorCode::RequiresMigration);
  Ok(())
}
```

## 4. `migrate` instruction

Minimal migrate structure (conceptual):

```
pub fn migrate(ctx: Context<Migrate>) -> Result<()> {
  let v = &mut ctx.accounts.vault;
  if v.version >= 2 { return Ok(()); } // idempotent
  // perform required migrations...
  v.version = 2;
  msg!("migrated vault to v2");
  Ok(())
}
```

## 5. Where and when to check `version` in other instructions

- Always check version at the start of any instruction that:
    - uses newly added fields,
    - changes permissions/roles,
    - affects funds or signer lists.

- For read-only queries or non-critical functions you may provide backward-compatible behavior, but prefer explicit checks for critical paths.
- Use a helper function or macro for consistent error messaging and logging.

## 6. Governance & upgrade authority best practices

- Never keep a single developer key as program upgrade authority in production.
- Use an on-chain multisig (Squads / other) or a governance realm to own program upgrade authority.
- Add a timelock period for upgrade execution to allow community review and emergency response.
- When appropriate and agreed by governance, set program to immutable (remove upgrade authority) — this is irreversible.

Common commands (examples):

```
# set upgrade authority to MULTISIG_PUBKEY
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <MULTISIG_PUBKEY>

# make program immutable (careful, irreversible)
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority "" --final
```
