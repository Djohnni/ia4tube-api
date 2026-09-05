# Production preparation checkpoint — NOT a deployable integration

Date: 2026-09-05. Base: `1bd987f1ecbbd3a64f2ad0e905d30649704f4b3c`,
reconfirmed as the live commit on service `srv-d8708kd7vvec73ap1p6g`.
The configured branch is main, but the remote main reference observed during
preparation is `f9ac0e93633475218bd740cfc1e1334c6bf73e45`. Do not substitute
that branch or the staging tree for the verified live base.

## Delivered locally

- Existing social/config/persistence modules and migrations brought from
  reference `c5c37a0b79aa897509283dfe9478a830f812097c` into a separate worktree.
  Existing production files, including FCM, are not replaced with that tree.
- Nine additive server lines: validation at startup and an explicitly closed
  `/v1/social` boundary. Enabling social persistence or external gates is
  refused; no runtime or pool is created. This is a safety checkpoint, not an
  implementation of authenticated production social endpoints.
- Strict immutable publication-intent identity/hash module v2, independently
  reviewed, including reconstruction from a stored snapshot. Its transaction,
  HTTP, credential-writer and Android integrations remain pending.
- Read-only production catalogue operator with exact target, system-trusted
  TLS, fixed query limits, sanitization and one read-only transaction. No apply
  command exists in this operator. Existing six SQL checksums are preserved.
- Existing dependencies preserved; only pg and the already-resolved tar-stream
  made direct dependencies. No lifecycle scripts were run during install.

## Actual new-database observation

At `2026-09-05T18:07:01.574Z`, the read-only transaction confirmed database
`ia4tube_social_production`, PostgreSQL `180006` (18.6), TLS and repeatable-read
read-only mode. There were zero user relations, custom functions/types/extensions
or social schemas; none of the three application roles, migration ledger or
environment marker existed. No migrations were applied. PUBLIC CONNECT exists;
PUBLIC CREATE on the public schema does not. No runtime/RLS proof is claimed.

Resource: `dpg-dae4tmf40ujc73dr2dog-a`, Oregon, 0.1 CPU/256 MB, 5 GB,
autoscaling/HA off. No new paid resource was acquired during this mission.

Fresh production-only identity, vault, prospective login passwords and backup
key were generated with cryptographic randomness and stored using CurrentUser
DPAPI plus private ACLs outside this repository. They are not activated. No
staging/FCM/JWT secret was read or reused. A same-machine DPAPI round-trip is not
a disaster-recovery or cross-machine escrow proof.

## Validation and limitations

The final local run selected 19 test files and passed **285 tests**, zero
failures/skips, with source hashes unchanged during execution. It covers pure
binding validation, catalogue mock tests, legacy HTTP/auth/orders/planning/FCM,
pool/role/RLS validation with test doubles, vault/reauth, and real loopback TLS
handshakes using synthetic certificates. The test process receives no inherited
service credentials and restricts Node networking to loopback.

The existing bundled Python cryptography package generates temporary test-only
certificates when OpenSSL is absent; no certificate is installed in the OS and
production trust configuration is not changed. No capacity/load or transactional
PostgreSQL concurrency proof is represented by these tests.

Independent review approves only this closed, partial checkpoint. It does not
approve deployment, social enablement, a prepared database or Android readiness.

## Concrete continuation blockers

1. No operational isolated recovery destination was found: WSL is not installed,
   and PostgreSQL 18/Docker are not operational locally. Disk free space exists,
   but no restore was performed. Existing backup operators require a Linux
   durability proof and do not cover a pre-bootstrap schema-zero profile.
2. The six existing migrations are already conditionally authorized. Their
   production execution route still needs implementation/review: the generic
   runner refuses pending 0005/0006 and dedicated routes are staging-specific.
   Do not remove those guards or pretend production is staging.
3. The separately proposed two-column additive migration requires specific
   authorization before application. See `social-publication-binding-v2-proposal.md`.
   No new migration, inferred backfill or arbitrary SQL repair was created.
4. Integrate the shared lock/immutable intent at reservation, every provider step,
   reconciliation and all connection/credential writers. Remove age-based
   uncertain-operation takeover and mutating history reads. Prove races physically
   with controlled fixtures before declaring the account/revision correction done.
5. Add backward-compatible social session-v2/auth and production-origin contracts;
   adapt Android to the agreed intent. No Android source was changed here, and the
   signed AAB 31 remains a separate preserved artifact, not a build of this tree.
6. Inbound IP rules still allow `0.0.0.0/0`. Restrict the exact resource after
   defining proven operator/runtime origins; do not change shared workspace rules.
   The screen-control safety policy requires manual handling of access settings.

## Sanitized future configuration matrix — not saved to live

| Configuration | Planned value or source | Current restriction |
| --- | --- | --- |
| `ENVIRONMENT` | `production` | No live edit |
| `PUBLIC_API_BASE_URL` | `https://ia4tube-api.onrender.com` | Production-origin contracts still pending |
| `SOCIAL_DATABASE_URL` | Production runtime login only, protected storage | Runtime role/login not created; operator URL forbidden here |
| `SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT` | Exact host/port/database fingerprint in DB preflight | Revalidate destination at activation |
| `SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN` | Dedicated production runtime principal, to be verified | No guessed deployed identity |
| `SOCIAL_DATABASE_POOL_MAX` | `3` | No pooler; migrator max 1, separately |
| `SOCIAL_TENANT_NAMESPACE_UUID`, `SOCIAL_IDENTITY_DERIVATION_VERSION`, `SOCIAL_IDENTITY_DERIVATION_KEY` | Fresh protected production material | Not staged, logged or activated |
| `SOCIAL_VAULT_ACTIVE_KEY_VERSION`, `SOCIAL_VAULT_KEYS_JSON`, `SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT` | Fresh protected production material | No FCM/JWT/staging reuse; registry not bootstrapped |
| Migration environment identity / marker / key registry | Must match physically verified production catalogue | Missing; not guessed or substituted with staging |
| `SOCIAL_PERSISTENCE_ENABLED` / `SOCIAL_INSTAGRAM_ENABLED` | Remain disabled in this checkpoint | Cannot enable this partial code |
| `SOCIAL_EXTERNAL_CONNECTION_ENABLED` | `false` | No OAuth/disconnect |
| `SOCIAL_EXTERNAL_PUBLICATION_ENABLED` | `false` | No publication/reconciliation with provider |
| `META_APP_REVIEW_WINDOW_ENABLED` | `false` | No submission |
| Existing JWT, FCM, payment, DATA_DIR and legacy settings | Preserve exact current configuration | Never copied to this document or overwritten |

Staging is untouched: real reviewer UI=true, connection=false, publication=false,
Meta review window=false. Business Verification remains historically verified;
App Review remains not submitted. Existing Meta forms, credentials, videos,
connection, post and history are not re-tested or mutated.

## Deployment and recovery prerequisites

Do not deploy this checkpoint. First resolve the scoped blockers, complete and
review the exact integrated tree, run all focal/physical proofs, produce the
corresponding signed Android artifact if changed, and confirm safe restoration
of database and legacy DATA_DIR with protected key escrow. Keep 256 MB database
pool/statement budgets; measured load/capacity must precede activation.

Only after these conditions and a separate human deployment authorization:
record the exact final SHA/configuration, prepare consistent backups and a
controlled cutover, apply the reviewed absent schema steps, configure runtime
credentials without operator access, deploy the exact candidate with external
gates closed and validate legacy/social health. Code/config rollback does not
undo database writes. Never restore over later writes without its own reviewed
procedure. No paid expansion or automatic scaling follows from this plan.
