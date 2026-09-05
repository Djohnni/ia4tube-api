"use strict";

const {
  CONNECTOR_CAPABILITIES,
  requireCapability,
  requireConnectorContext,
  requireEnvironment,
  requireProviderIdentifier
} = require("./contract");
const {
  connectorFail,
  normalizeConnectorError
} = require("./errors");

const CONNECTION_CAPABILITIES = new Set([
  "beginAuthorization",
  "discoverAccount",
  "disconnect"
]);

function createConnectorRegistry(options = {}) {
  const environment = requireEnvironment(options.environment);
  const connectors = new Map();
  const gates = Object.freeze({
    externalConnectionEnabled:
      options.gates?.externalConnectionEnabled === true,
    externalPublicationEnabled:
      options.gates?.externalPublicationEnabled === true,
    enabledProviders: new Set(options.gates?.enabledProviders || []),
    companyAllowlist: new Set(options.gates?.companyAllowlist || [])
  });
  let sealed = false;

  function register(connector) {
    if (sealed) connectorFail("connector_contract_invalid");
    if (!connector || typeof connector !== "object") {
      connectorFail("connector_contract_invalid");
    }
    const provider = requireProviderIdentifier(connector.provider);
    if (connectors.has(provider)) {
      connectorFail("connector_registration_duplicate");
    }
    if (connector.testOnly === true) {
      if (
        environment !== "test" ||
        connector.synthetic !== true ||
        connector.external !== false
      ) {
        connectorFail("synthetic_connector_forbidden");
      }
    } else {
      if (connector.synthetic === true) {
        connectorFail("synthetic_connector_forbidden");
      }
      if (connector.external !== true) {
        connectorFail("connector_contract_invalid");
      }
    }
    if (!Array.isArray(connector.capabilities)) {
      connectorFail("connector_contract_invalid");
    }
    const capabilities = [];
    for (const capability of connector.capabilities) {
      const valid = requireCapability(capability);
      if (capabilities.includes(valid)) {
        connectorFail("connector_contract_invalid");
      }
      if (typeof connector[valid] !== "function") {
        connectorFail("connector_contract_invalid");
      }
      capabilities.push(valid);
    }
    const methods = new Map();
    for (const capability of capabilities) {
      methods.set(capability, connector[capability].bind(connector));
    }
    connectors.set(provider, Object.freeze({
      capabilities: Object.freeze(capabilities),
      external: connector.external === true,
      invoke(capability, context, input) {
        return methods.get(capability)(context, input);
      },
      provider,
      testOnly: connector.testOnly === true
    }));
    return provider;
  }

  function seal() {
    sealed = true;
    return api;
  }

  function requireExternalGate(entry, context, capability) {
    if (!entry.external) return;
    const operationEnabled = CONNECTION_CAPABILITIES.has(capability)
      ? gates.externalConnectionEnabled
      : gates.externalPublicationEnabled;
    if (
      !operationEnabled ||
      !gates.enabledProviders.has(context.provider) ||
      !gates.companyAllowlist.has(context.companyId)
    ) {
      connectorFail("external_capability_disabled");
    }
  }

  async function invoke(context, capability, input) {
    if (!sealed) connectorFail("connector_contract_invalid");
    const trusted = requireConnectorContext(context, { environment });
    const requested = requireCapability(capability);
    const entry = connectors.get(trusted.provider);
    if (!entry) connectorFail("provider_not_supported");
    if (!entry.capabilities.includes(requested)) {
      connectorFail("capability_not_supported");
    }
    requireExternalGate(entry, trusted, requested);
    try {
      return await entry.invoke(requested, trusted, input);
    } catch (error) {
      throw normalizeConnectorError(error);
    }
  }

  function describe(provider) {
    const known = requireProviderIdentifier(provider);
    const entry = connectors.get(known);
    if (!entry) connectorFail("provider_not_supported");
    return Object.freeze({
      provider: entry.provider,
      capabilities: entry.capabilities,
      external: entry.external,
      testOnly: entry.testOnly
    });
  }

  const api = Object.freeze({
    describe,
    invoke,
    register,
    seal
  });
  return api;
}

module.exports = {
  CONNECTOR_CAPABILITIES,
  createConnectorRegistry
};
