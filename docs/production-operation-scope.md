# Production Instagram operation scope

This local change prepares an explicit production subject scope. It does not
open a gate, configure a real subject, run OAuth, or prove a real token or post.

`SOCIAL_PRODUCTION_OPERATION_ALLOWLIST_JSON` is server configuration, loaded at
social runtime startup. Its value is a JSON array of objects containing exactly
`companyId` and `userId`, both server-derived UUIDs from the legitimate product
identity. Both values must match the same entry; separate company and user lists
are not supported. Derive and verify the pair through the authorized product
session/identity procedure, never from a client-selected identifier or label.

With customer access disabled, the safe default is absence or `[]`. Both keep
production connection and publication disabled even if the global flags are
true. An empty string, invalid JSON, non-UUID value, missing/extra field,
duplicate field/pair, escaped field
spelling, more than 32 pairs, or more than 8192 characters is refused with a fixed
sanitized error. UUID case is normalized before duplicate checking. Supplying
this production configuration in another environment is refused.

An allowed production operation requires all of:

- The existing authenticated, branded production context, created after the
  signed product session and active/finalized-owner checks; OAuth callback uses
  its authenticated state and its persisted one-use authorization.
- Official production origin and enabled Instagram integration.
- An exact configured company/user pair, or the explicit customer-access rollout
  described below.
- The corresponding existing global gate. Publication also requires the
  connection gate. `META_APP_REVIEW_WINDOW_ENABLED=true` remains forbidden in
  production.

The fixed reviewer identity receives no automatic production exemption. It
follows the same production eligibility policy and global gates as other
customers. No real pair is supplied by this document or hard-coded into the
application.

`SOCIAL_PRODUCTION_CUSTOMER_ACCESS_ENABLED` is an explicit production rollout
switch. Absence or the literal `false` preserves the exact-pair allowlist policy.
The literal `true` also admits authenticated customers with legitimate
server-created contexts; the HTTP boundary still requires an active, finalized
product owner and a provisioned matching company/user membership. OAuth callback
and calendar execution retain their authenticated state or signed grants.
Other values, including an empty string, are refused. Enabling the switch outside
production or without social persistence is refused. The official production
origin, existing connection/publication gates, account binding and tenant
isolation remain mandatory. Existing allowlist entries and their validation are
preserved while the switch is enabled.

This policy is shared by connection availability, authorization, publication,
reconciliation and the calendar publisher. Production manual publication also
requires the existing calendar runtime (`SOCIAL_CALENDAR_ENABLED=true`), because
it queues the confirmed intent for the worker. The rollout does not enable
calendar-import pilots or change their separate owner policies.

Rollback consists of setting `SOCIAL_PRODUCTION_CUSTOMER_ACCESS_ENABLED=false`
and restarting/deploying the configuration; the preserved allowlist then applies
again. Closing the existing external gates remains the operation-wide stop.
Neither rollback nor gate closure cancels an already started provider request or
erases connections, credentials, history or publication intent records.

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
Meta window remain false. Any later opening is a separate authorization. Closing
the gates prevents new operations under that configuration; removing a pair
also does so for that pair when customer access is disabled. Neither action
cancels an already started request or erases credentials/history.

Focused proof uses synthetic identities, local HTTP, authenticated state, strict
SQL protocol doubles and a loopback-only network guard. It is not a new physical
RLS, production OAuth, credential-persistence or App Review proof.
