# Production preparation checkpoint — NOT a deployable integration

## Current continuation, 2026-09-05 — supersedes historical checkpoint below

Continuation base is local `a619eb422bdcb92c24b1498cc5cecc63df7a3169`.
The original 285-test report and AAB31 are immutable historical evidence.
They are not the approval evidence for this updated source.

Implemented and tested locally:

- Official server assembly: strict production origin/service/database pins,
  runtime schema validation before listener/background jobs, new signed v2
  sessions with legacy authentication preserved, independent authenticated
  tenant readiness, and separate social parsers before the legacy 50MB parser.
- Private `/reviewer`, scoped direct JPEG storage, same shared HTTP/persistence
  contract as Android. Stable external-account ID and connection revision are
  mandatory for a production publication and reconciliation. Local intent
  storage is separated by product owner. History can reconcile its original
  binding without a browser intent; no automatic provider POST on page load.
- Real OAuth service/router/provider/state envelope now accept only their
  exact environment callback. Production is not labelled staging. No OAuth
  was performed: protocol tests use synthetic state, fixtures and loopback.
- One shared advisory lock and durable stage claim coordinate account writers
  and publication. Uncertain operations cannot be taken over by age. Neither
  another account nor a newer revision can inherit an old intent. Legacy rows
  remain unbound rather than being assigned today's account.
- Migration0007 only adds the two specified binding fields and relevant
  constraints/restrictive policies; original0001–0006 bytes are unchanged.
  The complete SQL/profile/checksum is in the existing external promotion plan
  and `social-publication-binding-migration-0007.md`.
- New Node snapshot: **342 tests passed**, zero failed/skipped/cancelled, source
  hashes unchanged; report `PRODUCTION_PREPARATION_TESTS_2026-09-05T19-10-11-095Z.json`
  remains outside Git. Tests include actual local HTTP assembly/normalizers,
  Web intent behavior, integration SQL doubles, session isolation and legacy
  flows. A prior failed run is preserved and is not approval evidence; its
  static assertion was updated for five calls to the shared HS256 signer.
- Android inherits the already approved e11f4a6 snapshot, with only twelve
  Instagram source/test files changed against that base. Final Android:
  **149 tests passed** (not added to Node or historical counts), debug/release
  compilation and lint passed with zero errors. Signed AAB31 version0.2.19:
  `IA4Tube_0.2.19_31_production_binding_20027c862643.aab`, SHA256
  `5529388D0BA7DEB4D11760299E399FC53A365834F41A506FCCFF87857466D821`.
  Source digest `20027C862643619CE27AEFD7DA568C4D6C438F591B39C0BD5FA7C7EACECA4AEF`;
  no Play upload or A55 installation. Original AAB hash47B36E24… unchanged.

### Actual database and recovery state — no production writes

The proprietor manually saved the exact resource-specific rule
`177.125.241.117/32`, description `Preparacao temporaria - PC do proprietario`.
Reload confirmed it. Same-PC HTTPS observations from ipify/AWS agreed. Existing
workspace/environment rules were not changed. Remove the temporary rule only
after preparation and the definitive operational access path are confirmed.

At18:42:02UTC a fresh TLS/hostname-verified READ ONLY transaction succeeded
after the rule change. PostgreSQL18.6, same zero application catalog; no roles,
environment marker or migration ledger exist. **No production migration or
bootstrap was performed.** Protected catalog report SHA256
`EF36BD184D96EAB9B1CCA7859A17F8B7B0F3D40D84333C4BE39136AEDB2CAD48`.

A: two consistent catalog observations are preserved, but are not a backup or
protected restoration. B: portable PostgreSQL18.4 operated in a private local
directory on127.0.0.1:64997, with SCRAM/checksums and synthetic records only.
Physical0001–0007/catalog/ACL/RLS/FK/legacy tests, dump/restore profiles6/7 and
two independent store sessions with one stage winner passed. This does not
prove the canonical encrypted production recovery, Linux durability or a live
provider. C: existing DATA_DIR was not changed; consistent cutover/recovery
proof remains pending. Do not bootstrap production merely because B passed.

Smallest identified free Linux route: owner-provided existing isolated Linux,
or a manually installed WSL2 distribution on this PC (administrator/restart
may be required). No installation or additional cost is authorized/executed.
The Windows synthetic lab is stopped; retained artifacts are not real backups.

### Concrete remaining decisions and guards

1. Protected recovery A/C, Linux durability, independent key custody and the
   reviewed operator package must precede real role/marker/schema preparation.
   Dedicated production migration steps now exist but require exact resource,
   catalog hashes, journal and independently verified recovery callback. No
   `true` placeholder, generic runner bypass or operator secret in the service.
2. Current schema grants runtime SELECT only on companies/users/memberships.
   Login cannot create these rows. `tenant_not_provisioned` blocks the social
   endpoints safely. Proposed minimum route: three operator INSERTs in one
   transaction for each verified existing owner, plus an explicit strategy for
   future registrations. No such DML was prepared/executed. Automatic bootstrap
   via new grant/function is outside the two-column authorization; see
   `production-social-tenant-readiness.md` before requesting that change.
3. Physical production capacity/cutover and mobile runtime validation remain
   separate requirements. No deployment, account recreation or provider replay
   is justified by the local tests/AAB alone. An uncertain `igo:` crash can stay
   blocked safely pending evidence; liveness is not faked as success.

Current runtime variable is **DATABASE_URL**, not SOCIAL_DATABASE_URL; it must
contain the dedicated runtime credential only. The observed public hostname
with system trust/TLS is usable. The observed short internal hostname is pinned
but still rejected by the strict TLS hostname policy; no insecure exception or
guessed SNI was added. Production callbacks are prepared in code only, not saved
in Meta. All live settings remain unchanged.

Specific branch push was checked: no repository webhooks, only Render/Codex
Apps, Pages disabled, no workflow or blueprint in the pushed tree; official
Render tracks main with auto-deploy off, staging tracks its own branch, the
other project webservice uses another repository. No PR/merge is created.
Push is conditional on final scanner/diff/independent review, not a deployment.

`PROXIMA_ETAPA=CONCLUIR_PREPARACAO_E_INTEGRACAO`

`CANDIDATO_APTO_PARA_SOLICITAR_DEPLOY=NAO`

Business verification remains VERIFIED; App Review not submitted. All existing
forms, reviewer credentials, approved Web videos, post/history, external gates,
public/legal pages, live/staging services and billing remain untouched.

## Historical a619eb4 checkpoint below — not current status

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
