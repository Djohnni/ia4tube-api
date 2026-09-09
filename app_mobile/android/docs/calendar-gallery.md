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

### Home shortcut (Android40 / 0.2.27)

The Home screen now places **Minhas artes planejadas** immediately below Instagram. This protected `planned-arts` route uses the same `CalendarGallery`, authenticated calendar model, canonical schedule items and private-image cache as the existing calendar entry. It does not create a second list, authorize automatic publication or alter the Instagram connection. Back returns to the originating Home; repeated or stale callbacks cannot pop another screen. Existing calendar and Instagram entries retain their previous return labels and behavior.

Focused verification: 40 tests passed across nine suites, with zero failures, errors or skips: the26 calendar tests, two Home shortcut/render checks (including enlarged font), five planned-art navigation checks and seven existing Instagram-retention checks. Kotlin production/test compilation and whitespace validation passed. These are local checks; internal distribution and physical-device confirmation are recorded separately.

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

### Caption save confirmation (2026-09-09, local correction)

The editor now remains open while its single write is pending and closes only after the returned server snapshot has been installed in the calendar state. Pending actions show `Salvando…` and block another save. An unconfirmed response preserves the draft for the same session, explains that the change may already have been saved, and requires an explicit calendar refresh before another edit. There is no automatic write retry or extra GET after a successful POST, and no polling was added. Access denial or session invalidation removes the old editor and caption.

The Android39 source already consumed a complete POST snapshot; it did not intentionally postpone locally saved captions until reopening. The observed production edits have no captured POST response/status, so the historical runtime cause remains unproven. Synthetic tests cover complete HTTP POST JSON through the real parser and model, uncertain responses without repeated writes, and the updated caption rendered by the same Compose gallery instance. They also cover 401/403 and late results after invalidation. Direct AlertDialog interaction and rendering a pending animation under Robolectric encountered a frame-clock loop; those abandoned harness paths are not included or counted as a functional reproduction. Pending and late-response behavior is instead checked with the deterministic coroutine test dispatcher. No A55/device interaction is claimed by these local checks.

Validation of this local correction: all 26 calendar tests passed in six suites, with zero failures, errors or skips (`:app:testDebugUnitTest --offline --console=plain -Pkotlin.incremental=false --tests '*Calendar*Test'`). This includes seven added checks across HTTP/model and Compose rendering. Debug Kotlin compilation and `git diff --check` passed; version39/0.2.26 is unchanged. No release/AAB, commit, deployment or device operation was performed.

### Historical loading/lifecycle validation (before the caption correction)

Validation of the earlier correction: 134 focused debug unit/render tests passed, zero failures/errors/skips (19 calendar tests plus 115 existing monthly-planning/Instagram/navigation tests). The initial empty view now describes the one-minute loading window instead of saying the feature is unavailable during a pending read. The lifecycle tests explicitly flush Compose snapshots/layout and teardown, including pause/resume without an intermediate frame. Kotlin compilation and `git diff --check` passed; no new AAB, Play upload or phone installation was performed for that earlier correction. The already distributed AAB38 remained unchanged at that checkpoint.

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
