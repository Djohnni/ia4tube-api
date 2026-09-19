"use strict";
const { isAuthenticatedSocialPrincipal } = require("../../auth-adapter");
const { isVerifiedCalendarGrant } = require("../grants");
const { isCalendarStore } = require("../store");
const { isImportUploadPostgresStore } = require("./postgres-store");
const { isImportAccessPolicy } = require("./access-policy");
const { isPreparedDiskResultStore } = require("./prepared-disk-store");
const { isRenderDiskTransferService } = require("./transfer-service");
const { createPrivateImportPreviewService } = require("./preview-service");
const { createPreparedCalendarMedia } = require("./prepared-publication-media");
const { createOperationalCalendarImportService } = require("./local-calendar-service");
const { isLocalPublicationTransport } = require("./publication-test-transport");
const { LIMITS, licensedTrack } = require("./policy");
const { displayName } = require("./music-catalog");
const factories = new WeakMap(), runtimes = new WeakSet();
function fail() { throw Object.assign(new Error("Importação operacional indisponível."), { code: "calendar_import_runtime_invalid", statusCode: 503 }); }

// Explicit host composition, not an executor factory. No token, connector store,
// fetch fallback, FFmpeg startup, environment mutation or worker timer is owned
// here. The deployment must inject a separately supervised execution boundary.
function createOperationalCalendarImportsRuntimeFactory({ enabled = false, preparation, resultStore, accessPolicy,
  upload, provider, uploadStore, transfer, verifyReadiness, catalog = null,
  localTransport = null, allowLocalTransportForTests = false, clock = Date.now, canAdmit = () => true } = {}) {
  const local = isLocalPublicationTransport(localTransport);
  if (localTransport !== null && (!local || allowLocalTransportForTests !== true)) fail();
  if (typeof enabled !== "boolean" || typeof clock !== "function" || typeof canAdmit !== "function") fail();
  const factory = async ({ store, grants, secret, publicOrigin, connectionForPrincipal, connectionForGrant, publicationAllowedForPrincipal, readGeneratedArt } = {}) => {
    if (!enabled) return null;
    if (!isCalendarStore(store) || !isImportUploadPostgresStore(uploadStore) || !isImportAccessPolicy(accessPolicy) ||
        !isPreparedDiskResultStore(resultStore, { allowVolatileForTests: local }) ||
        !isRenderDiskTransferService(transfer) || transfer.available !== true ||
        typeof transfer.wrapUpload !== "function" || typeof verifyReadiness !== "function" ||
        provider?.getCapabilities?.().available !== true || provider.capabilities.testOnly && !local ||
        !["request", "status", "snapshot"].every(key => typeof preparation?.[key] === "function") ||
        !["start", "resume", "status", "authorizePart", "resolvePart", "complete", "cancel"].every(key => typeof upload?.[key] === "function") ||
        typeof connectionForPrincipal !== "function" || typeof connectionForGrant !== "function" ||
        typeof publicationAllowedForPrincipal !== "function" || typeof readGeneratedArt !== "function") fail();
    // These are real restricted schema checks; the callback adds deployment-
    // specific executor/disk checks and cannot replace the branded requirements.
    await store.verify();
    if (await uploadStore.verify() !== true || await verifyReadiness() !== true) fail();
    let closed = false;
    const principals = new WeakMap();
    function allowed(context) { try { if (closed) return false; accessPolicy.resolve(context); return true; } catch { return false; } }
    function owner(context) { if (!allowed(context)) fail(); return accessPolicy.resolve(context); }
    function principalFor(context) {
      owner(context); const principal = principals.get(context);
      if (!isAuthenticatedSocialPrincipal(principal) || principal.companyId !== context.companyId || principal.userId !== context.userId) fail();
      return principal;
    }
    const resolveConnection = (context, grant) => {
      owner(context);
      if (grant !== undefined) {
        if (!isVerifiedCalendarGrant(grant) || grant.companyId !== context.companyId || grant.userId !== context.userId) fail();
        return connectionForGrant(grant);
      }
      return connectionForPrincipal(principalFor(context));
    };
    const scheduling = createOperationalCalendarImportService({ store, grants, preparation, resultStore, accessPolicy,
      resolveConnection, catalog, upload, provider, uploadStore, clock, enabled: true, localTransport,
      resolveAutomaticAllowed: context => publicationAllowedForPrincipal(principalFor(context)) === true,
      resolveGeneratedArt: (context, request) => readGeneratedArt(principalFor(context), request) });
    const preview = createPrivateImportPreviewService({ preparation, resultStore, accessPolicy, enabled: true, allowVolatileForTests: local });
    const preparedMedia = createPreparedCalendarMedia({ store, grants, preparation, resultStore, accessPolicy,
      resolveConnection, secret, publicOrigin, clock, enabled: true, localTransport });
    if (!preparedMedia.available || !preview.available) { preparedMedia.close(); scheduling.close(); fail(); }
    const runtime = Object.freeze({ ready: true, scheduling, preview, preparedMedia, transfer,
      upload: transfer.wrapUpload(upload), preparation, allowed,
      canAdmit(context) { return allowed(context) && canAdmit() === true; },
      contextForPrincipal(principal) {
        if (!isAuthenticatedSocialPrincipal(principal)) fail();
        const context = Object.freeze({ authenticated: true, companyId: principal.companyId, userId: principal.userId });
        // Identity is not eligibility. The router's allowed check still returns
        // disabled capabilities to an authenticated but ineligible owner.
        principals.set(context, principal); return context;
      },
      capabilities(context) {
        const audience = owner(context).audience, musicTracks = [];
        for (const track of catalog?.values?.() || []) {
          try {
            const authorized = licensedTrack(catalog, track.id, { companyId: context.companyId, audience, now: clock(), publishAt: clock(), testMode: local });
            musicTracks.push({ id: authorized.id, displayName: displayName(track.displayName, authorized.id),
              commercialRightsConfirmed: authorized.testOnly !== true, testOnly: authorized.testOnly === true });
          } catch { /* Unavailable rights are never advertised as an approved track. */ }
        }
        return { enabled: true, localSimulation: local, readyForProduction: false,
          scheduling: { enabled: true, localSimulation: local },
          upload: { origin: publicOrigin, chunkBytes: LIMITS.chunkBytes, maxImageBytes: LIMITS.imageBytes, maxVideoBytes: LIMITS.videoBytes },
          preparation: { enabled: true, minVideoSeconds: 3, maxVideoSeconds: 60, photoMusicSeconds: LIMITS.photoClipSeconds }, musicTracks };
      },
      close() { if (!closed) { closed = true; preparedMedia.close(); scheduling.close(); } }
    });
    runtimes.add(runtime); return runtime;
  };
  factories.set(factory, { local, enabled }); return Object.freeze(factory);
}
function isOperationalCalendarImportsRuntimeFactory(value, { allowLocalTransportForTests = false } = {}) {
  const entry = factories.get(value); return Boolean(entry && (!entry.local || allowLocalTransportForTests));
}
function isOperationalCalendarImportsRuntime(value) { return runtimes.has(value); }
module.exports = { createOperationalCalendarImportsRuntimeFactory, isOperationalCalendarImportsRuntimeFactory, isOperationalCalendarImportsRuntime };
