"use strict";
const crypto = require("node:crypto");
const { createConnectorContext } = require("../connectors/contract");
const { isAuthenticatedSocialPrincipal } = require("../auth-adapter");
const { fail } = require("./model");
const { isOperationalCalendarImportsRuntimeFactory } = require("./imports/operational-runtime");
const { createCalendarStore } = require("./store");
const { createCalendarSource } = require("./source");
const { createCalendarMedia } = require("./media");
const { createCalendarGrants } = require("./grants");
const { createCalendarPublisher } = require("./publisher");
const { createCalendarService } = require("./service");
async function createProductionCalendar(dependencies, ports) {
  const store = createCalendarStore({ pool: ports.pool, role: ports.role });
  await store.verify(); // Optional additive schema must be prepared separately; never migrate at startup.
  const source = createCalendarSource(dependencies);
  const media = createCalendarMedia({ ...dependencies, publicOrigin: ports.config.publicOrigin, loadSource: source.load });
  let grants, imports;
  try {
    grants = createCalendarGrants(dependencies.secret, dependencies.clock);
    let publisher;
    const connectorContext = principal => {
      if (!isAuthenticatedSocialPrincipal(principal)) fail("calendar_session_required", 401);
      return createConnectorContext({ principal, provider: "instagram", environment: ports.config.environment,
        correlationId: crypto.randomUUID(), auditEventId: crypto.randomUUID() });
    };
    if (dependencies.importsRuntimeFactory !== undefined) {
      // Production never accepts the local transport opt-in, even a genuine one.
      if (!isOperationalCalendarImportsRuntimeFactory(dependencies.importsRuntimeFactory)) fail("calendar_import_runtime_invalid", 503);
      imports = await dependencies.importsRuntimeFactory({ store, grants, secret: dependencies.secret,
        publicOrigin: ports.config.publicOrigin,
        connectionForPrincipal: principal => publisher.connection(connectorContext(principal)),
        publicationAllowedForPrincipal: principal => publisher.allowed(connectorContext(principal)),
        connectionForGrant: grant => publisher.connection(connectorContext(ports.auth.fromVerifiedCalendarGrant(grant))),
        connectionForSubmission: grant => publisher.connection(connectorContext(ports.auth.fromVerifiedCalendarSubmission(grant))),
        async readGeneratedArt(principal, request) {
          if (!isAuthenticatedSocialPrincipal(principal) || typeof principal.subject !== "string") fail("calendar_session_required", 401);
          const job = await store.update(principal.companyId, state => state.jobs[request.calendarItemId]);
          if (!job || job.sourceKind === "upload" || job.revision !== request.revision || job.phase === "cancelled" || !job.asset ||
              !await media.unchanged(principal.subject, job)) fail("calendar_import_source_changed");
          const bytes = media.bytesFor(principal.companyId, job.asset);
          const current = await store.update(principal.companyId, state => state.jobs[request.calendarItemId]);
          if (!current || current.revision !== job.revision || current.phase === "cancelled") fail("calendar_import_source_changed");
          return { bytes, mimeType: "image/jpeg" };
        } });
    }
    publisher = createCalendarPublisher({ ...ports, media, preparedMedia: imports?.preparedMedia });
    const calendar = createCalendarService({ ...dependencies, ...ports, store, source, media, grants, publisher,
      importScheduling: imports?.scheduling });
    return Object.freeze({ ...calendar, imports: imports || null,
      async close() { try { await calendar.close(); } finally { imports?.close(); } } });
  } catch (error) {
    imports?.close();
    grants?.close();
    media.close();
    throw error;
  }
}
module.exports = { createProductionCalendar };
