# Calendar bridge and scheduled-art gallery — local implementation

Implementation date: 2026-09-08. Base backend: `376a26489b9872b75b9db3470e84deb69f3c6445`.
Branch: `feat/calendar-instagram-bridge-gallery-20260908`. This document is not deployment authorization.

## Product contract

The existing large Home +, generation request, review, generation pipeline and calendar remain the source of the artwork. Connecting Instagram does not itself authorize background publication. A one-time, explicit preference in the Instagram area authorizes **new** generation requests for the bound professional account. The ordinary request confirmation describes that automatic behavior. Old requests are never retroactively authorized.

The optional gallery and the existing calendar read the same canonical schedule. A caption edit changes the post text, not lettering embedded in the artwork. Rescheduling moves the same record. Cancellation removes only its future schedule: original artwork, order, other schedules, connection and already published history remain. A dispatch intent freezes edits/cancellation before provider I/O.

The existing Instagram image/caption section displays the next scheduled art. Manual preparation remains a separate explicit choice; the background scheduler does not depend on the Android process or tap the manual Publish button.

## Components

- `src/social/calendar/source.js`: resolves owned generation requests, child orders, final caption and `resultado_final.png` through existing product storage. Payment/download restrictions remain.
- `grants.js`: purpose-separated HMAC order capability, bound to company/user, planning ID, quantity and immutable connection identity/revision. Private receipt outside the generator directory; no password, fabricated JWT or Instagram token in the receipt/API.
- `media.js`: owned final image to sRGB JPEG1080x1080, fit/white padding without crop, maximum8MiB. Original remains untouched. SHA-bound private derivative, authenticated preview and fifteen-minute signed provider URL. No remote source URL fetching.
- `model.js`, `store.js`: canonical schedule, revision compare-and-set, cancellation tombstones and immutable intents. Tenant transaction and advisory lock include the first absent row.
- `publisher.js`: adapter to the **existing** bound Instagram connector, service, provider-stage claims and history. Exact post caption; no review hashtags or caption-based inference of publication identity.
- `service.js`: in-process worker every15seconds while the service runs. Automatic items have preparation priority. Stores intent before dispatch, observes the same intent after interruption and never retries an uncertain create POST. Positive provider evidence alone produces Published.
- `router.js`: `/v1/social/calendar`, authenticated preferences/edits/images; existing production session and tenant-readiness middleware. Body-supplied company identifiers cannot replace the authenticated owner.

Existing generation endpoints only gain narrow adapter hooks. Existing calendar hide/reagendar routes target the canonical record when present, with revision protection for automatic items. Calendar reads overlay canonical caption/date/status. Legacy requests without an automatic receipt retain their existing manual-post reminder. Automatically authorized requests do not receive the contradictory old “post manually now” reminder. Generation-ready notifications were not changed.

## Off by default; existing database, no new resource

`SOCIAL_CALENDAR_ENABLED` defaults to false. True also requires the existing social persistence and Instagram runtime. External connection/publication gates and the existing exact company/user allowlist are still independently enforced. No gate or default allowlist was broadened.

The additive extension is `db/calendar-migrations/0001_calendar_bridge.up.sql`. It creates **one table** in a separate `ia4tube_calendar` schema in the existing social database; it does not replace core migrations0001–0008. It uses the established owner/runtime roles, forced RLS, a company FK and no runtime DELETE/TRUNCATE/company-ID-update permission. Runtime verifies the extension before exposing it. Missing/altered schema refuses activation. **Startup never runs a migration.**

No migration was applied on Render. Future application requires an explicitly authorized operator session, exact destination and prerequisite grants verified first. Do not grant wider privileges to resolve a failure automatically. The script is one-time, transactional and deliberately does not silently replace an existing schema.

Only sharp0.35.4 and its locked dependencies were added. Existing dependency-lock records are preserved, including root semver7.8.0; sharp has its own semver version. No native OS installation or new server resource was performed. Linux native dependency loading and live memory consumption remain deployment checks, not claims established by the Windows tests.

## Safety and limits

- Schedule uses America/Sao_Paulo. Dispatch checks every15seconds, with a ten-minute late grace. Beyond that, show overdue and require rescheduling; never publish accumulated overdue items in a burst. No exact-to-the-second guarantee during server/provider unavailability.
- Original delegated consent lasts180days. Rescheduling cannot extend beyond it. Expired/changed connection or credential, missing scopes, inactive account, closed gates and pause all block a new dispatch.
- Up to1000 retained records/8MiB per company, including cancellation/history. No automatic history deletion. Capacity exhaustion requires a later retention/product decision.
- Preparation is bounded to two images per owner sync, prioritizing automatic items. No capacity/load claim for a large customer population.
- Invalid generated caption is attention for that artwork, not a silent truncation or failure of the entire company. The owner can enter a valid caption. Failed preparation or replaced final image does not silently reuse old approval.
- Unknown provider result stays locked/uncertain. A known container may continue through the existing connector's durable stage claim; an unknown create operation never starts a replacement. A stopped process between recording intent and recording provider data may require manual investigation of the same intent.
- Signed media links are short-lived capabilities; never log/share them or treat them as permanent public gallery URLs. No credentials or receipts go to the generator, Android API response, support ticket or Git.
- The bridge is not credential auto-renewal, a bulk publisher, multi-network scheduling, customer rollout authorization, or a new App Review request.

## Rollback boundary

Close external gates before any rollback decision; preserve pending intents and reconcile their known state before reopening anything. Disabling the calendar feature stops the worker without deleting schedule/history.

Canonical changes are stored in PostgreSQL and overlaid onto legacy calendar responses while enabled. Original plan JSON dates/hidden flags are not rewritten by gallery edits. Therefore an old binary or disabled feature can display original dates/items: **do not treat an old calendar UI as the active publication truth or promise identical rollback presentation**. A rollback does not authorize resending items. Preserve extension data and derivatives; no down/delete script is included.

## Executed local verification

- 204 Node tests passed across calendar model/media/source/HTTP/publisher and existing production assembly, operation scope, generation, compatibility and atomic publication contracts; zero failures/skips.
- One separate physical PostgreSQL18.4 synthetic/loopback test passed: additive migration, forced tenant isolation, forbidden company-ID update, rollback, unchanged read revision, eight competing claims with one winner, tampered policy rejection. Temporary process and cluster removed. No Render URL or real data used.
- Windows sharp conversion and immutable exact-caption publisher flow used synthetic images/provider transport. No real Instagram operation.
- Compatibility checks still compare the remaining legacy server and prior lock entries, exempting only the enumerated new adapter hooks and new dependencies. This is not a replacement for all historical server tests or a live deployment test.

Focal command from this repository:

```powershell
node --test tests/calendar-bridge.test.js tests/calendar-source.test.js tests/calendar-publisher.test.js tests/calendar-http.test.js tests/production-social-http-assembly.test.js tests/production-social-live-compatibility.test.js tests/production-social-operation-scope.test.js tests/monthly_planning_photo_items.test.js tests/social-publication-connection-binding.test.js tests/social-publication-atomic-integration.test.js
```

The physical test is separately opt-in with `CALENDAR_TEST_PG_BIN` pointing to an already available local PostgreSQL bin directory and `node --test tests/calendar-postgres.test.js`. It only creates its own synthetic loopback cluster. Its execution is not required for ordinary production startup.

## Next environment validation, not performed

Under a future specific authorization: review the exact commits/destination, apply only this additive extension, deploy the backend with external gates closed, verify Linux sharp and owned calendar responses, then build a uniquely numbered Android candidate for internal Play testing. Do not reuse versionCode37 or overwrite its approved AAB.

Validate creation-to-calendar, gallery edit/cancel and next-content behavior on the installed candidate before a separately authorized, bounded real publication window. The existing Android37 Meta route and its historical real-publication evidence remain independent. No push, deploy, migration, Play change, OAuth, Instagram publication or Meta submission was performed in this implementation.
