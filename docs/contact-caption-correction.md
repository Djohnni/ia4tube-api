# Optional contact and caption confirmation — 2026-09-09

Local correction, based on backend `955be18dbbb1a9d831fb64ab599c7e2c9370a1a4`. This is not a deployment, migration, gate-opening or publication authorization.

## Contact is not authentication identity

Monthly planning takes the optional public WhatsApp contact only from the explicit contact field. Empty/omitted contact stays empty: neither the client account key nor the planning owner is a public-contact fallback. Login, owner paths, billing and connection ownership are unchanged.

Explicit contact must be a string containing 10–15 digits, starting with a nonzero digit, with optional leading `+` and space/parenthesis/hyphen separators. Letters are rejected before removing separators. Invalid nonempty input returns `monthly_planning_invalid_whatsapp_contact` / HTTP 400 before reservation, persistence or calendar-grant creation. This is syntactic validation, not verification that a WhatsApp account exists.

Child generation revalidates the stored profile contact; invalid legacy contact is omitted rather than passed into the image/caption prompts. Existing finished results and the running desktop motor are not modified by this patch. A numeric contact inherited by older planning cannot be distinguished retrospectively from a deliberately entered number; no migration guesses that consent.

## Confirmation belongs to the edit transaction

Previously, calendar editing committed the mutation and then called the full listing again. A subsequent synchronization/connection-read failure could turn a successfully persisted edit into HTTP 503. Synthetic regressions reproduce this path; they do not prove that it caused every historical stale-caption observation.

Editing now synchronizes and reads connection/availability metadata before the mutation. The owner-scoped transaction applies the revision-checked edit and builds the full existing snapshot response from that same state. The store returns only after commit succeeds. There is no post-commit listing, automatic POST retry, new publisher call, new consent or change to worker behavior.

The JSON contract is unchanged: `ok`, `enabled`, `preferences`, `connection`, `operationsAllowed`, `timeZone`, `serverTime`, `items`, `next`. The updated caption and revision are in the POST response, so clients do not need polling or an extra successful-path GET to display the saved text. The edited item still shares its existing ID, image and calendar record.

A lost commit acknowledgement or lost HTTP response can still leave an uncertain outcome. Such failures must not be retried automatically. Clients must retain the draft, avoid claiming success, and require a fresh read before further editing. The Android companion change keeps its editor open until a matching response is confirmed.

## Verification

`tests/monthly-planning-contact.test.js` covers empty/omitted/null contact with textual/numeric login, an explicit contact different from identity, invalid values before any reservation, and three persisted synthetic children with unchanged ownership.

`tests/calendar-bridge.test.js` adds failed post-write-read reproduction, preflight failure without changing the caption, full updated snapshot over loopback HTTP, no second synchronization, owner isolation in the response, and a lost-commit-acknowledgement case with one mutation only. Existing revision conflicts and dispatch/edit locks remain covered.

All fixtures use synthetic accounts and transport. No production/staging credentials, external Instagram requests or paid generation are required.

```powershell
node --test tests/monthly-planning-contact.test.js tests/monthly_planning_photo_items.test.js tests/calendar-bridge.test.js tests/calendar-http.test.js tests/calendar-read-recovery.test.js tests/calendar-source.test.js tests/calendar-publisher.test.js
```

The optional physical PostgreSQL suite remains separate; this patch does not alter the schema, transaction implementation, roles or RLS policies. Existing artwork automatic-publication authorization is unchanged and remains a separate product decision.
