import { validateSiteSpecSemantics } from "../contracts/validate-site-spec-semantics.mjs";
import { sha256Json } from "./canonical-json.mjs";
import { PersistenceError } from "./errors.mjs";
import validateSchema from "./generated/site-spec-validator.mjs";

export const SITE_SPEC_SCHEMA_VERSION = "1.2.0";
export const READINESS_EVALUATOR_VERSION = "draft-readiness-1";

const EDITABLE_FIELDS = [
  "companyName",
  "niche",
  "salesRegion",
  "businessType",
  "siteType",
  "networkType"
];
const SERVER_OWNED_FIELDS = new Set([
  "projectId",
  "schemaVersion",
  "revision",
  "readiness",
  "documentStage"
]);
const BUSINESS_TYPES = new Set(["wholesale", "manufacturer", "distributor", "services", ""]);
const SITE_TYPES = new Set(["landing", "multipage", "catalog", "seo-network", ""]);
const NETWORK_TYPES = new Set(["single", "regions", "niches", "domains", ""]);
const BUSINESS_TYPE_MAP = {
  wholesale: "wholesale",
  manufacturer: "manufacturer",
  distributor: "distributor",
  services: "b2b_services"
};
const SITE_TYPE_MAP = {
  landing: "landing",
  multipage: "multipage",
  catalog: "catalog",
  "seo-network": "seo_network"
};
const NETWORK_MODE_MAP = {
  single: "single",
  regions: "regions",
  niches: "niches",
  domains: "separate_domains"
};
const NETWORK_STRATEGY_MAP = {
  single: "single_wordpress_site",
  regions: "one_wordpress_multiregion",
  niches: "multiple_wordpress_sites",
  domains: "multiple_wordpress_sites"
};
const NETWORK_UI_MAP = {
  single: "single",
  regions: "regions",
  niches: "niches",
  separate_domains: "domains"
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, field, maxLength) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new PersistenceError("VALIDATION_FAILED", `${field} must be a string.`, {
      status: 422,
      details: { field }
    });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new PersistenceError("VALIDATION_FAILED", `${field} is too long.`, {
      status: 422,
      details: { field, maxLength }
    });
  }
  return normalized;
}

function assertAllowedChoice(value, values, field) {
  if (!values.has(value)) {
    throw new PersistenceError("VALIDATION_FAILED", `${field} has an unsupported value.`, {
      status: 422,
      details: { field }
    });
  }
}

export function assertNoServerOwnedFields(payload) {
  if (!isPlainObject(payload)) {
    throw new PersistenceError("VALIDATION_FAILED", "The request body must be a JSON object.", {
      status: 422
    });
  }
  const containers = [payload, isPlainObject(payload.draft) ? payload.draft : null].filter(Boolean);
  for (const container of containers) {
    if (Object.hasOwn(container, "documentStage") && container.documentStage !== "draft") {
      throw new PersistenceError(
        "UNSUPPORTED_STAGE_TRANSITION",
        "This API can only save draft SiteSpec revisions.",
        { status: 409, details: { requestedStage: container.documentStage } }
      );
    }
    for (const field of SERVER_OWNED_FIELDS) {
      if (Object.hasOwn(container, field)) {
        throw new PersistenceError("SERVER_OWNED_FIELD", `${field} is assigned by the server.`, {
          status: 422,
          details: { field }
        });
      }
    }
  }
}

export function normalizeEditableDraft(value) {
  if (!isPlainObject(value)) {
    throw new PersistenceError("VALIDATION_FAILED", "draft must be a JSON object.", {
      status: 422,
      details: { field: "draft" }
    });
  }
  const unknownFields = Object.keys(value).filter((key) => !EDITABLE_FIELDS.includes(key));
  if (unknownFields.length > 0) {
    throw new PersistenceError("VALIDATION_FAILED", "draft contains unsupported fields.", {
      status: 422,
      details: { fields: unknownFields.sort() }
    });
  }

  const draft = {
    companyName: text(value.companyName, "companyName", 200),
    niche: text(value.niche, "niche", 500),
    salesRegion: text(value.salesRegion, "salesRegion", 200),
    businessType: text(value.businessType, "businessType", 50),
    siteType: text(value.siteType, "siteType", 50),
    networkType: text(value.networkType, "networkType", 50)
  };
  assertAllowedChoice(draft.businessType, BUSINESS_TYPES, "businessType");
  assertAllowedChoice(draft.siteType, SITE_TYPES, "siteType");
  assertAllowedChoice(draft.networkType, NETWORK_TYPES, "networkType");
  return draft;
}

function draftCheck(id, present, messagePresent, messageMissing) {
  return {
    id,
    required: true,
    status: present ? "passed" : "missing",
    message: present ? messagePresent : messageMissing
  };
}

function buildReadiness(draft) {
  return {
    ownedBy: "server",
    evaluatorVersion: READINESS_EVALUATOR_VERSION,
    generation: {
      status: "not_ready",
      checkedAt: null,
      checks: [
        draftCheck(
          "business_model_selected",
          Boolean(draft.businessType),
          "A business model is selected.",
          "A business model is required."
        ),
        draftCheck(
          "site_model_selected",
          Boolean(draft.siteType),
          "A site model is selected.",
          "A site model is required."
        ),
        draftCheck(
          "network_mode_selected",
          Boolean(draft.networkType),
          "A network mode is selected.",
          "A network mode is required."
        ),
        {
          id: "remaining_brief_sections_completed",
          required: true,
          status: "missing",
          message: "The remaining brief sections are not part of this persistence milestone."
        }
      ]
    },
    publish: {
      status: "not_ready",
      checkedAt: null,
      checks: [
        {
          id: "publication_review_completed",
          required: true,
          status: "missing",
          message: "Publication readiness is not evaluated for draft persistence."
        }
      ]
    }
  };
}

function buildBusiness(draft) {
  const facts = draft.niche
    ? [
        {
          key: "business.niche",
          value: draft.niche,
          status: "supplied",
          provenance: {
            sourceType: "user_input",
            sourceId: "brief.niche",
            assetId: null,
            notes: null
          },
          verifiedAt: null,
          verification: null,
          publishAllowed: false
        }
      ]
    : [];
  const missingFactKeys = [];
  if (!draft.companyName) missingFactKeys.push("business.name");
  if (!draft.businessType) missingFactKeys.push("business.type");
  if (!draft.niche) missingFactKeys.push("business.niche");
  if (!draft.salesRegion) missingFactKeys.push("business.geography");

  return {
    name: draft.companyName || null,
    type: BUSINESS_TYPE_MAP[draft.businessType] ?? null,
    audience: [],
    geography: draft.salesRegion ? [draft.salesRegion] : [],
    facts,
    missingFactKeys
  };
}

function buildNetwork(draft) {
  if (!draft.networkType) return undefined;
  return {
    mode: NETWORK_MODE_MAP[draft.networkType],
    siteStrategy: NETWORK_STRATEGY_MAP[draft.networkType],
    inheritance: {
      shared: [],
      overridable: [],
      overrideSemantics: "missing_inherits_explicit_value_overrides_null_clears_only_when_clearAllowed_true"
    },
    sites: []
  };
}

function schemaErrors() {
  return (validateSchema.errors ?? []).map((error) => ({
    keyword: error.keyword,
    path: error.instancePath,
    message: error.message
  }));
}

export function validateCanonicalSiteSpec(siteSpec) {
  if (!validateSchema(siteSpec)) {
    throw new PersistenceError("VALIDATION_FAILED", "The generated SiteSpec failed JSON Schema validation.", {
      status: 422,
      details: { validation: "schema", errors: schemaErrors() }
    });
  }
  const semanticErrors = validateSiteSpecSemantics(siteSpec);
  if (semanticErrors.length > 0) {
    throw new PersistenceError("VALIDATION_FAILED", "The generated SiteSpec failed semantic validation.", {
      status: 422,
      details: { validation: "semantic", errors: semanticErrors }
    });
  }
}

export function buildDraftSiteSpec({ projectId, revision, draft: input }) {
  const draft = normalizeEditableDraft(input);
  const siteSpec = {
    schemaVersion: SITE_SPEC_SCHEMA_VERSION,
    revision,
    projectId,
    documentStage: "draft",
    siteModel: SITE_TYPE_MAP[draft.siteType] ?? null,
    language: "ru-RU",
    business: buildBusiness(draft),
    readiness: buildReadiness(draft)
  };
  const network = buildNetwork(draft);
  if (network) siteSpec.network = network;
  validateCanonicalSiteSpec(siteSpec);
  return {
    siteSpec,
    canonicalSha256: sha256Json(siteSpec),
    editableSha256: sha256Json(draft),
    draft
  };
}

export function editableDraftFromSiteSpec(siteSpec) {
  const nicheFact = siteSpec.business?.facts?.find((fact) => fact.key === "business.niche");
  const businessType = Object.entries(BUSINESS_TYPE_MAP).find(([, value]) => value === siteSpec.business?.type)?.[0] ?? "";
  const siteType = Object.entries(SITE_TYPE_MAP).find(([, value]) => value === siteSpec.siteModel)?.[0] ?? "";
  return {
    companyName: siteSpec.business?.name ?? "",
    niche: typeof nicheFact?.value === "string" ? nicheFact.value : "",
    salesRegion: siteSpec.business?.geography?.[0] ?? "",
    businessType,
    siteType,
    networkType: NETWORK_UI_MAP[siteSpec.network?.mode] ?? ""
  };
}

export function readinessRows(siteSpec) {
  const rows = [];
  for (const gate of ["generation", "publish"]) {
    for (const check of siteSpec.readiness[gate].checks) {
      rows.push({
        gate,
        ...check,
        evaluatorVersion: siteSpec.readiness.evaluatorVersion,
        checkedAt: siteSpec.readiness[gate].checkedAt
      });
    }
  }
  return rows;
}
