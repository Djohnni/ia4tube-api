# Production tenant binding — read-only profile 7 and prepared profile 8

No real owner/company/membership has been materialized by this local work.
The observed empty production catalog and schema preparation are not evidence
that product owners have been imported. The code now prepares legitimate
on-login provisioning for a separately reviewed additive profile 8; it has not
applied that structure or written product data to production or staging.

Migration 0001 grants the runtime only column-level SELECT on `companies`,
`users` and `company_memberships`; runtime catalog validation requires those
exact grants. Migrations 0002–0007 add no bootstrap function or runtime INSERT
on those three tables. Automatic provisioning cannot execute under the
historical 0001–0007 privilege contract. Profile 8 adds only a dedicated
function/EXECUTE capability; it does not grant direct table INSERT/UPDATE or an
operator credential to the webservice.

## Implemented safe boundary

`createProductionTenantReadiness({authAdapter:runtime.auth,
companies:runtime.companies})` is a read-only guard. Mount its `middleware`
**after** the official `session.authenticate` and **before** authenticated social
routes. It must not intercept unauthenticated Meta compliance or OAuth callback
routes, which have their own signature/state authority. A possible wrapper is:

```js
const tenantReadiness = createProductionTenantReadiness({
  authAdapter: runtime.auth, companies: runtime.companies
});
const authenticateSocial = (req, res, next) => session.authenticate(
  req, res, () => tenantReadiness.middleware(req, res, next)
);
```

The session verifier first validates the actual signed v2 session and active
official legacy owner. The guard then uses the branded identity adapter (which
enforces `sub == whatsapp == company_id`) and one tenant-scoped SELECT joining
the derived company/user/membership. All must be active, membership must be
owner, and derivation version must match. It reads no password/login digest and
does no writes, repair, reactivation or role promotion. Missing/disabled
provisioning returns HTTP 503 `tenant_not_provisioned`; database errors are a
fixed sanitized `social_tenant_readiness_unavailable`. Invalid session binding
returns 401. This is an eligibility snapshot, not a claim of a distributed
transaction with the legacy files or a replacement for stage/account binding.

## Prepared official login integration — no separate login or endpoint

The five existing POST session issuances (password login, registration, Google
login, automatic registration and automatic-account finalization) now await
`productionSocialIntegration.afterAuthentication(owner)` after their original
authentication/authorized write and before the unchanged synchronous JWT signer.
The original handlers and authentication failures remain intact; the two newly
async handlers without an existing catch forward errors to Express 4's error
handler. No new endpoint, client company selector, Android change or password
store is introduced.

With social disabled the hook returns before touching product records, identity
configuration, runtime, timers or SQL. When enabled it re-reads the official
product owner and requires `ativo === true`. An automatic account not yet
finalized is ineligible: its temporary renameable identifier must never gain a
social connection that would need migration by guessed username. Finalization
uses the authorized final identity. The social session verifier independently
enforces these active/finalized conditions on existing JWTs; legacy `auth` and
the JWT signer's behavior are unchanged.

Only the internal authenticated owner is passed to the existing HMAC identity
adapter. The branded JWT principal supplies derived company/user UUIDs and
derivation version; raw identity, name, password, Instagram username, role and
client body/query fields are never SQL parameters. The callback itself is not
an authentication API: its caller must already have completed the official
credential/Google/registration checks. The social database does not contain
the legacy registry and cannot independently prove a password or Google login.

## Exact additive database capability

The separate profile 8 preparation defines
`ia4tube_social.ensure_official_owner(uuid, uuid, text)`. It is SECURITY DEFINER
owned by `ia4tube_social_owner`, with a pinned safe search path and EXECUTE only
for the runtime. The repository sets both transaction-local company and user
scope and supplies only those UUIDs and the version. Existing FORCE RLS remains.
The returned row is strictly checked before commit: company/user/version,
`role='owner'`, safe positive `auth_version`, and boolean `created`.

The function serializes the company's creation. Only a wholly absent company
may receive the three records atomically: company named the fixed technical
label `IA4Tube`, user with `password_hash NULL`, active owner membership. The
required `login_key_digest` is an opaque SHA-256 identity marker, not a login
credential or password digest: UTF-8 `ia4tube-social-official-owner-v1`, lowercase
company UUID, lowercase user UUID and derivation version joined by LF with no
trailing LF. It is calculated inside SQL, not accepted from a client. No new
extension, table, column or role is needed.

Replays verify the exact active single-user/single-owner identity, digest and
version without updates. Partial, suspended/disabled, multi-user, non-owner or
otherwise conflicting records return reserved SQLSTATE `PTB01`; neither the
function nor the webservice repairs, reactivates, upgrades or overwrites them.
Migrations 0001–0007 remain unchanged. The runtime only exposes the repository
for production when the physical catalog validator returns the explicit
`officialOwnerProvisioning: true` marker. Historical profiles cannot opt in by
an environment flag or migration-count guess.

## Failure, latency and recovery limits

Database/function errors are converted to fixed safe social codes. The official
JWT and legacy login response remain legitimate after an already-running
server experiences social database failure; the read-only social guard still
fails closed. **Cold startup is different:** existing physical database/schema
validation still prevents the listener from starting when social is enabled
and its database is unavailable. This work does not weaken that startup gate.

Login waits at most two seconds for the hook. A process-local map retains every
started writer until settlement, deduplicates the same derived identity and
admits at most three distinct concurrent writers; it creates no retry worker.
The transaction also sets 1.5-second statement and 1-second lock timeouts.
A login deadline is not a SQL cancellation: connection acquisition, transport
or COMMIT/ROLLBACK may settle later. A later retry uses the same deterministic
binding and the function checks it idempotently. Shutdown refuses new work,
waits boundedly and reports pending count without claiming cancellation; normal
runtime/pool shutdown remains responsible for releasing connections. In-flight
status/logs expose no owner, UUID, query, driver detail or credential.

GET/current/history still use only `findActiveOwner`; they never provision or
repair. Users with a pre-existing session and no social tenant must complete
the existing login again after profile 8 is installed. Web and Android then
see the same records through the existing API; no new OAuth or app build is
required for this tenant prerequisite alone.

The only identified product key rename is the one-time automatic-account
finalization. The route rejects already finalized accounts; normal `/me`
updates display fields, not the owner key. No historical connection or
publication is transferred by name. A future product identity model supporting
renaming or multiple members requires its own explicit design.

Focused adapter/HTTP tests use synthetic principals and a strict SQL protocol
double; they are not proof of PostgreSQL ACL/RLS/concurrency. Separate physical
profile-8 migration, adversarial grants, race and restoration tests remain the
database owner's responsibility. Local prepared code and those tests do not
mean this structure or any real tenant has been applied in production. Recovery,
review, exact catalog/journal authorization and production materialization are
still prerequisites. Deployment, staging, Meta and all external gates remain
unchanged.
