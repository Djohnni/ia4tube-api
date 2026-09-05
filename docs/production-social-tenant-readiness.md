# Production tenant prerequisite — deliberately not auto-provisioned

The new database has no product company/user/membership seed supplied by this
candidate. The previously observed empty social catalog and subsequent schema
preparation are not evidence that real product owners have been imported.
Nothing here creates an owner, inserts product data, changes grants or runs SQL
against a live resource.

Migration 0001 grants the runtime only column-level SELECT on `companies`,
`users` and `company_memberships`; runtime catalog validation requires those
exact grants. Migrations 0002–0007 add no bootstrap function or runtime INSERT
on those three tables. Automatic provisioning at login therefore cannot safely
be implemented with the current privilege contract. Giving the webservice an
operator credential is not an alternative.

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

## Minimum proposed operational route — not implemented or executed

For each existing real owner, an explicitly approved operator workflow outside
the webservice could derive the same company/user IDs and login-key HMAC from
the protected production identity configuration and an authenticated official
owner record. In one scoped transaction using the existing authorized owner
role, it would insert only:

1. `companies`: derived ID, validated product display name, active status and
   exact identity derivation version.
2. `users`: same company and derived user ID, domain-separated login digest,
   active status; do not copy a staging reviewer password or identity. The
   nullable password field is not an invitation to import review credentials.
3. `company_memberships`: same company/user pair, owner role and active status.

Any existing mismatch, suspended/disabled row or partial state must stop and
be reviewed, not be overwritten/upgraded by an UPSERT. A replay must verify the
exact intended existing rows. The workflow needs approved source binding,
protected material handling, transaction/journal evidence and restoration
coverage before execution. No SQL operator helper has been created here.

Provisioning only today's owners does not solve future registration. The
strategy for new product users remains an explicit pending decision: an
approved out-of-band workflow or a separately authorized narrowly scoped
database function/grant contract. That structural change is outside 0007's
two-field authorization. This prerequisite keeps
`CANDIDATO_APTO_PARA_SOLICITAR_DEPLOY=NAO` until resolved. All external gates and
the live webservice remain unchanged.
