"use strict";
const crypto = require("node:crypto");
const { createConnectorRegistry } = require("../connectors/registry");
const { createSocialConnectorService } = require("../connectors/service");
const { createInstagramPublicationConnector, parseConfirmedReference } = require("../publication/instagram-publication-connector");
const { createPublicationIntent } = require("../publication/connection-binding");
const { canProductionOperation } = require("../production-operation-policy");
const { fail } = require("./model");
function createCalendarPublisher({ config, connectorStore, connectorAudit, credentials, transport, media }) {
  const allowed = context => canProductionOperation(config, context, "externalPublicationEnabled");
  function assemble(context, job) {
    if (!allowed(context)) fail("calendar_operations_closed");
    const descriptor = media.descriptor(context.companyId, job);
    const scopedMedia = Object.freeze({ async resolveOwnedJpeg(candidate, id) {
      if (candidate !== context || id !== descriptor.mediaId) fail("calendar_media_owner_invalid", 403);
      return descriptor;
    } });
    const registry = createConnectorRegistry({ environment: config.environment, gates: {
      externalConnectionEnabled: true, externalPublicationEnabled: true,
      enabledProviders: ["instagram"], companyAllowlist: [context.companyId] } });
    registry.register(createInstagramPublicationConnector({ config, store: connectorStore, credentials,
      media: scopedMedia, transport, authorizeContext: candidate => candidate === context && allowed(candidate),
      authorizeConnection: connection => connection.account?.externalId === job.authorization.binding.externalId &&
        ["business", "creator"].includes(connection.account?.accountType),
      authorizePublicationRequest: input => input.image.mediaId === descriptor.mediaId && input.caption === job.caption,
      authorizePublication: input => input.owned.metadataDigest === descriptor.metadataDigest && input.caption === job.caption,
      // Commercial captions are exact. Identical text is NOT evidence of identity.
      authorizePublishedCandidate: () => false, allowOperationReferenceReconciliation: false }));
    registry.seal();
    return { descriptor, service: createSocialConnectorService({ registry, store: connectorStore,
      audit: connectorAudit, media: scopedMedia, publicationBindingRequired: true }) };
  }
  function intent(context, job, requestId) {
    const descriptor = media.descriptor(context.companyId, job);
    return createPublicationIntent({ companyId: context.companyId, clientRequestId: requestId,
      binding: job.authorization.binding, mediaId: descriptor.mediaId,
      mediaMetadataDigest: descriptor.metadataDigest, caption: job.caption });
  }
  async function status(context, id) {
    const record = await connectorStore.scope(context).getPublicationDetails(id);
    if (!record) return null;
    const confirmed = record.state === "published" && record.confirmedProviderReference
      ? parseConfirmedReference(record.confirmedProviderReference) : null;
    return { state: record.state, published: Boolean(confirmed),
      mediaId: confirmed?.mediaId || null, permalink: confirmed?.permalink || null,
      publishedAt: confirmed ? confirmed.publishedEpochSeconds * 1000 : null };
  }
  return Object.freeze({ allowed, intent, status,
    async connection(context) {
      const connection = await connectorStore.scope(context).getCurrentConnectionDetails();
      if (!connection || connection.state !== "connected" || connection.health !== "healthy" ||
          !connection.activeCredentialId || !["business", "creator"].includes(connection.account?.accountType) ||
          !["instagram_business_basic", "instagram_business_content_publish"].every(scope => (connection.grantedScopes || []).includes(scope))) return null;
      return { binding: { connectionId: connection.id, externalId: connection.account.externalId,
        connectionRevision: connection.revision }, username: connection.account.username };
    },
    async observe(context, job) {
      const current = await status(context, job.intent.publicationId);
      if (current?.published || !allowed(context)) return current;
      const record = await connectorStore.scope(context).getPublicationDetails(job.intent.publicationId);
      // The existing connector owns stage claims. An uncertain create POST (igo:) is never repeated.
      if (record?.state === "provider_confirming" && /^igc:|^igm:/.test(record.reconciliationReference || "")) {
        try {
          const { service } = assemble(context, job);
          await service.getPublicationStatus(context, { publicationId: job.intent.publicationId,
            operationId: crypto.randomUUID(), providerReference: record.reconciliationReference,
            binding: job.authorization.binding });
        } catch { /* The durable uncertain intent stays visible; never create a replacement. */ }
      }
      return status(context, job.intent.publicationId);
    },
    async send(context, job) {
      const { service, descriptor } = assemble(context, job);
      const planned = job.intent;
      // Stored intent reused on every observation, never generated again after a timeout.
      if (await status(context, planned.publicationId)) return status(context, planned.publicationId);
      await service.publishImage(context, { operationId: planned.operationId, publicationId: planned.publicationId,
        connectionId: job.authorization.binding.connectionId, clientRequestId: planned.clientRequestId,
        binding: job.authorization.binding, image: { mediaId: descriptor.mediaId, mimeType: "image/jpeg",
          metadataDigest: descriptor.metadataDigest }, caption: job.caption });
      return status(context, planned.publicationId);
    }
  });
}
module.exports = { createCalendarPublisher };
