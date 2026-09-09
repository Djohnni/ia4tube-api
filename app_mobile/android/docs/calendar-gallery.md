# Scheduled-art gallery — Android implementation

Local work of2026-09-08, branch `feat/android-calendar-gallery-20260908`, based on Android `7f95487db5a2583172c513dc1abfa35fe93ad65a` (37/0.2.24).

## Delivered flow

1. Existing Instagram connection and explicit one-time automatic preference for new requests.
2. Existing large + → create one/multiple arts → Continue → review → Send generation request.
3. Existing generated-art calendar; automatic notice appears before submitting generation when enabled.
4. Button **Ver minhas artes programadas** below Calendário geral.
5. Native vertical pager, one artwork at a time, starts today/next date; unresolved older automatic items remain accessible above it. No likes, comments or Keep action.
6. Final prepared JPEG displayed without cropping, caption, date/time and true status. Side actions: Legenda, Data/hora, Situação, Excluir.
7. Caption editor changes only Instagram post text. Date/time moves the same schedule. Delete confirms removal only of the schedule, preserving original art/order/history.
8. Existing Instagram section **2. Imagem e legenda** shows the next canonical scheduled art. Explicit manual preparation is separate, not a second automatic dispatch path.

## Implementation

`feature/calendar/CalendarApi.kt`, `CalendarViewModel.kt` and `CalendarGallery.kt` use the official production API, the existing legitimate IA4Tube session, authenticated owned JPEGs and no image-cache reuse across sessions. No bearer forwarding to arbitrary URLs or redirects. No passwords or provider tokens are stored by this feature.

Follow-up: [private-art-cache.md](private-art-cache.md) documents the new encrypted, session-bound local copy shared by result/calendar/gallery views. It replaces direct image loading without adding polling. Revalidation still checks the server; it reuses unchanged image bytes, never a previous account's copy. The validation counts below are the historical checkpoints of the preceding changes, not the final cache test run.

New data loads only while resumed; leaving/session replacement invalidates fresh state. An offline or stale view cannot show a reliable green scheduled status or issue edits. Conflicts require refresh; writes are not automatically retried. Editing/cancellation is disabled once the server begins dispatch. The server is authoritative about scheduling and publication.

### Stable gallery snapshot and one-minute wait (follow-up correction)

- Calendar JSON and authenticated JPEG reads use an explicit 60-second read timeout and a 60-second total call timeout. Connection/write limits remain 10 seconds; redirects and automatic connection retries remain disabled. TLS verification and session isolation are unchanged. The later private-copy implementation adds conditional revalidation without enabling a shared HTTP/Coil image cache.
- Removed the 15-second polling loop. The calendar model loads once on screen entry/app resume. The gallery also requests a fresh snapshot on each opening because both parent screens retain the same model when the gallery is closed.
- While the gallery stays open, elapsed time and unrelated recomposition do not reload its list. Opening it again or using **Atualizar** requests current data. User-confirmed caption/date/cancellation changes still use the server's returned snapshot; they are not delayed until reopening.
- Backgrounding the app still invalidates fresh state and returning reads once. Pending requests are coalesced by the existing busy guard. Revision, owner/session, conflict and uncertain-result safeguards are preserved.
- A longer timeout does not hide a real HTTP 503 or prove every production failure resolved. This addresses premature client read timeouts and continuous refresh; production/device confirmation remains separate from local checks.

Focused regression coverage includes an actual loopback HTTP response delayed 12 seconds (past the previous default 10-second read limit), timeout/security configuration, a slow in-flight read without duplicate actions, visible non-retried 503, and real Compose lifecycle entry/reopening/manual refresh/background behavior with synthetic data. No diagnostics-only release is needed.

Validation of this correction: 134 focused debug unit/render tests passed, zero failures/errors/skips (19 calendar tests plus 115 existing monthly-planning/Instagram/navigation tests). The initial empty view now describes the one-minute loading window instead of saying the feature is unavailable during a pending read. The lifecycle tests explicitly flush Compose snapshots/layout and teardown, including pause/resume without an intermediate frame. Kotlin compilation and `git diff --check` passed; no new AAB, Play upload or phone installation was performed for this correction. The already distributed AAB38 remains unchanged.

Existing monthly-calendar DTO/cache and edit calls carry canonical revision/status. The old backend's missing calendar route is treated as unavailable, preserving the old manual path. A fresh preference check precedes generation submission so an unknown automatic setting cannot silently authorize an order.

The actual backend service is required for this feature; it is not a phone timer. Do not expose an automatic-ready status when the bridge, scopes, connection or gates are unavailable.

## Evidence

Debug Kotlin compilation passed. 126 focused tests passed: 11 calendar/view/render tests, 62 existing Instagram UI/ViewModel tests, 46 monthly creation/send tests and7 navigation-retention tests. Zero failures/errors. Native Robolectric renders exercise the actual Compose gallery/IA4Tube theme with a synthetic artwork, normal and1.5x font size. Side labels were widened based on font scale after visual inspection.

The internal renderer override is null in production; it exists only for deterministic, network-free visual tests. Preview images are not screenshots of an installed A55 or evidence of real Instagram publication. Existing unrelated OrderDetailScreen warning at line237 remains; no change was made to that behavior.

Test selection, using the existing offline toolchain:

```powershell
gradle :app:testDebugUnitTest --offline --console=plain '-Pkotlin.incremental=false' --tests '*Calendar*Test' --tests '*MonthlyPlanning*' --tests '*InstagramNavigationRetentionTest' --tests '*InstagramUiStateTest' --tests '*InstagramViewModelTest'
```

No release/AAB was generated and versionCode/versionName were deliberately not advanced. No app was installed, uninstalled or cleared. AAB37, signing material and historical evidence are untouched. The future authorized internal release must use the next actually available versionCode; do not submit this changed source again as37.

Before declaring the feature live: authorized backend extension/deployment with gates closed, unique internal candidate, Play installation and end-to-end device validation; real external scheduling requires a separate controlled window. This development does not postpone or substitute the existing37 Meta submission route.
