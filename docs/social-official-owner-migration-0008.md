# Official owner provisioning — additive 0008, local preparation only

Migration: `0008_social_official_owner_provisioning`.
SQL SHA256: `65a24b7e2171320623dba1d2d5d5e63b5679545ae1d0ca3a706765608a5b5dc6`.
Canonical function-body SHA256: `84d5b8698c4b3f4f194b9721b5779615e34fcf9c9791dad0a559799b73734051`.
Profile: `social-schema-0008`. Original 0001–0007 SQL bytes and pins remain unchanged.

This is a separately presented structural addition beyond the two-field 0007.
It is prepared in code only. No production/staging DDL or tenant DML has been
executed by this preparation. Real application remains gated on protected
recovery, exact target/catalog/journal, tests and independent review.

## Exact database change

One function, `ia4tube_social.ensure_official_owner(uuid, uuid, text)`, owned by
`ia4tube_social_owner`, `SECURITY DEFINER`, `VOLATILE`, language `plpgsql`, fixed
`search_path=pg_catalog`. PUBLIC EXECUTE is revoked; only runtime receives
non-grantable EXECUTE besides the owner's inherent authority. No new table,
column, role, policy, extension, direct table/column DML grant or global role
membership. Existing FORCE RLS and tenant policies continue applying to the
owner. Every relation and called function is schema-qualified.

Arguments are `requested_company_id`, `requested_user_id` and
`requested_identity_derivation_version`. Both `ia4tube.company_id` and
`ia4tube.user_id` must match the corresponding UUID exactly. The repository
sets these with transaction-local configuration and the canonical runtime role;
commit/rollback clears them before connection reuse.

Return fields: `company_id uuid`, `user_id uuid`,
`identity_derivation_version text`, `role text`, `auth_version bigint`,
`created boolean`. Conflict SQLSTATE is `PTB01`, with constant error text.

## Narrow all-or-none behavior

An advisory transaction lock keyed by company serializes function calls.
Existing company, users and memberships are row-locked before inspection.
Only when all three sets are absent does the function insert exactly one
company, one user and one owner membership. Any subsequent failure rolls back
all three inserts. No UPDATE, DELETE, upsert, repair, revival or import exists.

The company label is fixed `IA4Tube`. No client label or login identifier is
stored. Password is NULL; this function is not a second password registry.
`login_key_digest` is SHA256 over UTF8 of these four lines, without a final LF:
the domain `ia4tube-social-official-owner-v1`, lowercase company UUID, lowercase
user UUID, derivation version. PostgreSQL built-in SHA256 requires no extension.

Idempotent repetition accepts only one active company with that fixed label and
version, exactly one active user with matching ID/digest and NULL password, and
exactly one active owner membership for that user. It returns `created=false`
and preserves the existing auth_version (positive JavaScript-safe integer).
Partial rows, different owner/version/digest, multiple users/memberships,
disabled/locked/suspended/archived states and non-NULL passwords are conflicts.
Future multi-user companies require a separately reviewed contract; they are not
silently adopted or repaired by this function.

## Authority and proof boundaries

Only the trusted server may derive these IDs from the verified official login
and invoke the repository. HTTP clients do not select company IDs, user IDs or
identity versions. The database does not possess the legacy login registry or
the HMAC derivation secret; matching GUCs and parameters are NOT cryptographic
proof of that login. A compromised runtime database credential can set custom
GUCs and invoke this narrow creation capability. It still receives no direct
identity-table DML, but this design does not claim to defeat such compromise.

Runtime profile8 verifies exact function signature/body hash/owner/language,
volatility/security/configuration, effective EXECUTE, ACL, unchanged identity
table ownership/FORCE RLS and absence of runtime DML. It alone returns
`officialOwnerProvisioning=true`; historical profile7 does not. Existing
profiles3–7 remain distinct. Backup profile8 requires both binding-schema proof
and the exact official-owner body digest; profile7 evidence is not rewritten.

## Prepared verification and operation

`tests/social-official-owner-migration.test.js` validates SQL limits, immutable
history, catalog refusals, profile separation and recovery gates using fixtures.
The separate local `local-pg18-owner-lab.js`/`local-pg18-owner-proof.js` scenario
must prove the actual SQL, concurrent creation, isolation, refusals/rollback,
GUC cleanup, catalog drift and restore8. Its report is separate from the closed
Windows B report and is not evidence of protected production recovery.

Local/test routes are `planOfficialOwnerProvisioning` and
`applyOfficialOwnerProvisioning`, restricted to the single 0007→0008 step on an
explicit loopback disposable database. The old publication-binding route stays
limited to 0006→0007. Generic migration apply refuses pending0008. Production
uses its separately pinned one-step route and mandatory independent recovery
verifier; no boolean placeholder or direct SQL workaround is allowed.

## Isolated physical result — not production recovery

After independent review of both new tools, the first physical execution
finished at `2026-09-06T01:01:17.347Z` (05 September local time). External report:
`PG18_OFFICIAL_OWNER_2026-09-06T01-01-17-347Z.json`, SHA256
`64bb7c56ac941ac9ad3e9588d3d5f28fc4f7092f16cf175a0e5b190c295b447b`.
All 15 phases passed and 48 scoped source hashes were unchanged during and after
execution. The original Windows B tools/report remain unchanged and separate.

Actual PostgreSQL18.4 on private Windows loopback64996 proved: explicit historic
profile7 without provisioning; profile8 runtime/catalog; two independent real
repository sessions with one creation winner; repeat without mutation; two
tenant isolation; server/SQL digest agreement; both GUCs cleared; 13 conflict
cases without repair; auth_version preserved; PUBLIC execution and direct DML
denied; rollback of all three inserts on a forced constraint failure; body,
owner, search_path and ACL drift refusal; existing publication-binding store
regression with no provider; physical dump/restore8 with exact catalog and
ordered row digests/counts across all 20 evidence tables, unchanged after two
idempotent repository calls on the restored database.

Independent post-run checks found zero postgres/pg_ctl processes and zero
listeners64996/64997. The private synthetic directory remains for inspection.
This does not prove canonical encrypted backup, Linux durability, recovery of
production DATA_DIR/keys, external identity authenticity or provider behavior.
No production/staging operation was executed, and deploy remains unauthorized.
