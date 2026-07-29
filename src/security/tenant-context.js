"use strict";

const PRINCIPAL_FIELDS = Object.freeze(["sub", "user_id", "id", "whatsapp"]);
const TENANT_FIELDS = Object.freeze(["company_id", "tenant_id"]);
const DEFAULT_ALLOWED_ROLES = Object.freeze(["owner", "admin", "member"]);

class TenantContextError extends Error {
  constructor(code, status = 403, message = "Acesso nao autorizado.") {
    super(message);
    this.name = "TenantContextError";
    this.code = code;
    this.status = status;
  }
}

function normalizeTenantIdentifier(value, label = "tenant") {
  const identifier = String(value ?? "").trim();
  if (
    !identifier ||
    identifier.length > 200 ||
    identifier === "." ||
    identifier === ".." ||
    /[\/\\?#\u0000-\u001f\u007f]/.test(identifier)
  ) {
    throw new TenantContextError(`invalid_${label}_identifier`, 403);
  }
  return identifier;
}

function firstSignedIdentifier(source, fields, label) {
  for (const field of fields) {
    if (source?.[field] !== undefined && source?.[field] !== null && source?.[field] !== "") {
      return normalizeTenantIdentifier(source[field], label);
    }
  }
  return "";
}

function authenticatedPrincipal(req) {
  const auth = req?.auth || req?.user || null;
  if (!auth || typeof auth !== "object") {
    throw new TenantContextError("authentication_required", 401, "Autenticacao obrigatoria.");
  }

  const principalId = firstSignedIdentifier(auth, PRINCIPAL_FIELDS, "principal");
  if (!principalId) {
    throw new TenantContextError("invalid_authenticated_principal", 401, "Autenticacao obrigatoria.");
  }

  return { auth, principalId };
}

function signedTenantIdentifier(auth) {
  return firstSignedIdentifier(auth, TENANT_FIELDS, "tenant");
}

function membershipIsActive(membership) {
  const status = String(membership?.status || "").trim().toLowerCase();
  return Boolean(
    membership &&
    typeof membership === "object" &&
    (status === "active" || (!status && membership.active === true)) &&
    membership.active !== false &&
    membership.disabled !== true &&
    membership.revoked !== true
  );
}

function tenantIsActive(tenant) {
  const status = String(tenant?.status || "").trim().toLowerCase();
  return Boolean(
    tenant &&
    typeof tenant === "object" &&
    (status === "active" || (!status && tenant.active === true)) &&
    tenant.active !== false &&
    tenant.disabled !== true
  );
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function sendTenantError(res, error) {
  const status = Number(error?.status) || 403;
  return res.status(status).json({
    ok: false,
    code: error?.code || "tenant_access_denied",
    error: status === 401 ? "Autenticacao obrigatoria." : "Acesso nao autorizado."
  });
}

function createTenantContextMiddleware({
  resolveTenant,
  resolveMembership,
  resolveLegacyTenant = null,
  allowedRoles = DEFAULT_ALLOWED_ROLES
} = {}) {
  if (typeof resolveTenant !== "function") {
    throw new TypeError("resolveTenant deve ser informado.");
  }
  if (typeof resolveMembership !== "function") {
    throw new TypeError("resolveMembership deve ser informado.");
  }
  if (resolveLegacyTenant !== null && typeof resolveLegacyTenant !== "function") {
    throw new TypeError("resolveLegacyTenant invalido.");
  }

  const normalizedAllowedRoles = new Set(
    [...allowedRoles].map(normalizeRole).filter(Boolean)
  );
  if (!normalizedAllowedRoles.size) {
    throw new TypeError("Ao menos um papel deve ser autorizado.");
  }

  return async function tenantContextMiddleware(req, res, next) {
    try {
      const { auth, principalId } = authenticatedPrincipal(req);
      let tenantId = signedTenantIdentifier(auth);

      if (!tenantId && resolveLegacyTenant) {
        const legacyTenant = await resolveLegacyTenant({
          auth: Object.freeze({ ...auth }),
          principalId,
          req
        });
        if (legacyTenant !== undefined && legacyTenant !== null && legacyTenant !== "") {
          tenantId = normalizeTenantIdentifier(legacyTenant, "tenant");
        }
      }
      if (!tenantId) {
        throw new TenantContextError("tenant_claim_required", 403);
      }

      const tenant = await resolveTenant({ tenantId, principalId });
      if (!tenant || typeof tenant !== "object") {
        throw new TenantContextError("tenant_not_available", 403);
      }

      const resolvedTenantId = normalizeTenantIdentifier(
        tenant.id ?? tenant.tenant_id ?? tenant.company_id,
        "tenant"
      );
      if (resolvedTenantId !== tenantId || !tenantIsActive(tenant)) {
        throw new TenantContextError("tenant_not_available", 403);
      }

      const membership = await resolveMembership({
        tenantId,
        principalId,
        tenant
      });
      if (!membershipIsActive(membership)) {
        throw new TenantContextError("tenant_membership_required", 403);
      }

      const membershipTenantId = normalizeTenantIdentifier(
        membership.tenant_id ?? membership.company_id ?? membership.tenantId,
        "tenant"
      );
      const membershipPrincipalId = normalizeTenantIdentifier(
        membership.principal_id ?? membership.user_id ?? membership.principalId,
        "principal"
      );
      const role = normalizeRole(membership.role);
      if (
        membershipTenantId !== tenantId ||
        membershipPrincipalId !== principalId ||
        !normalizedAllowedRoles.has(role)
      ) {
        throw new TenantContextError("tenant_membership_denied", 403);
      }

      req.tenantContext = Object.freeze({
        principalId,
        role,
        tenantId
      });
      return next();
    } catch (error) {
      if (error instanceof TenantContextError) {
        return sendTenantError(res, error);
      }
      return sendTenantError(
        res,
        new TenantContextError("tenant_resolution_failed", 503, "Acesso nao autorizado.")
      );
    }
  };
}

function requireTenantContext(req) {
  const context = req?.tenantContext;
  if (!context || typeof context !== "object") {
    throw new TenantContextError("tenant_context_required", 403);
  }

  return Object.freeze({
    principalId: normalizeTenantIdentifier(context.principalId, "principal"),
    role: normalizeRole(context.role),
    tenantId: normalizeTenantIdentifier(context.tenantId, "tenant")
  });
}

function assertResourceTenant(context, resourceTenantId, { hideExistence = true } = {}) {
  const trustedContext = requireTenantContext({ tenantContext: context });
  let normalizedResourceTenantId = "";
  try {
    normalizedResourceTenantId = normalizeTenantIdentifier(resourceTenantId, "tenant");
  } catch {
    throw new TenantContextError(
      hideExistence ? "resource_not_found" : "resource_tenant_invalid",
      hideExistence ? 404 : 403,
      hideExistence ? "Recurso nao encontrado." : "Acesso nao autorizado."
    );
  }

  if (trustedContext.tenantId !== normalizedResourceTenantId) {
    throw new TenantContextError(
      hideExistence ? "resource_not_found" : "resource_tenant_mismatch",
      hideExistence ? 404 : 403,
      hideExistence ? "Recurso nao encontrado." : "Acesso nao autorizado."
    );
  }
  return trustedContext;
}

async function tenantScopedLookup({
  context,
  resourceId,
  findByTenantAndId
} = {}) {
  if (typeof findByTenantAndId !== "function") {
    throw new TypeError("findByTenantAndId deve ser informado.");
  }
  const trustedContext = requireTenantContext({ tenantContext: context });
  const normalizedResourceId = normalizeTenantIdentifier(resourceId, "resource");
  const resource = await findByTenantAndId({
    tenantId: trustedContext.tenantId,
    resourceId: normalizedResourceId
  });

  if (!resource) {
    throw new TenantContextError("resource_not_found", 404, "Recurso nao encontrado.");
  }
  return resource;
}

module.exports = {
  DEFAULT_ALLOWED_ROLES,
  PRINCIPAL_FIELDS,
  TENANT_FIELDS,
  TenantContextError,
  assertResourceTenant,
  authenticatedPrincipal,
  createTenantContextMiddleware,
  membershipIsActive,
  normalizeRole,
  normalizeTenantIdentifier,
  requireTenantContext,
  sendTenantError,
  signedTenantIdentifier,
  tenantIsActive,
  tenantScopedLookup
};
