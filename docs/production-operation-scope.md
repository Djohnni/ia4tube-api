# Production Instagram operation scope

This local change prepares an explicit production subject scope. It does not
open a gate, configure a real subject, run OAuth, or prove a real token or post.

`SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON` is server configuration, loaded at
social runtime startup. Its value is a JSON array of objects containing exactly
`companyId` and `userId`, both server-derived UUIDs from the legitimate product
identity. Both values must match the same entry; separate company and user lists
are not supported. Derive and verify the pair through the authorized product
session/identity procedure, never from a client-selected identifier or label.

The safe default is absence or `[]`. Both keep production connection and
publication disabled even if the global flags are true. An empty string, invalid
JSON, non-UUID value, missing/extra field, duplicate field/pair, escaped field
spelling, more than 32 pairs, or more than 8192 characters is refused with a fixed
sanitized error. UUID case is normalized before duplicate checking. Supplying
this production configuration in another environment is refused.

An allowed production operation requires all of:

- The existing authenticated, branded production context, created after the
  signed product session and active/finalized-owner checks; OAuth callback uses
  its authenticated state and its persisted one-use authorization.
- Official production origin and enabled Instagram integration.
- An exact configured company/user pair.
- The corresponding existing global gate. Publication also requires the
  connection gate. `META_APP_REVIEW_WINDOW_ENABLED=true` remains forbidden in
  production.

The fixed reviewer identity receives no automatic production exemption. It can
operate in production only when its own pair is explicitly included and the
gates allow the operation. For preparation of the owner's test, include only the
separately verified operational owner pair; preserve the reviewer company for
its separately authorized future review window. No real pair is supplied by
this document or hard-coded into the application.

Staging keeps its existing reviewer window and storage rules. A scoped reviewer
in production uses the ordinary production storage and immutable publication
binding, not staging-only idempotency/disconnection methods. Unknown `igo:`
publication results remain blocked without the staging lookup exception.

`GET /v1/social/connections/instagram` continues returning exactly the existing
`operationalAvailability.connectionAllowed` and `publicationAllowed` booleans.
It shares the policy used by authorization, callback, publication, reconciliation
and disconnection. Provider adapters also enforce the scope; production OAuth
requires a trusted context even for URL construction. This GET remains
observational; excluded subjects cannot trigger legacy mapping repair through a
by-ID/health GET. Other authenticated reads retain tenant isolation.

Android 33 and existing web consumers need no endpoint, response, login, scope or
build change. Keep the original connection binding and intent UUID, including
after a missing response. Reconciliation may finish the original provider send
and still requires explicit confirmation. It is not a new publication and never
adopts another account, revision or company.

Configuration changes take effect on service startup/restart. There is no timed
window or automatic closure. Prepare the scope while both external gates and the
Meta window remain false. Any later opening is a separate authorization; closing
the gates or removing the scope prevents new operations under that configuration
but does not cancel an already started request or erase credentials/history.

Focused proof uses synthetic identities, local HTTP, authenticated state, strict
SQL protocol doubles and a loopback-only network guard. It is not a new physical
RLS, production OAuth, credential-persistence or App Review proof.
