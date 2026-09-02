export const SITE_SPEC_SEMANTIC_ERROR_CODES = [
  "DUPLICATE_ID",
  "MISSING_CATEGORY_PARENT",
  "CATEGORY_PATH_MISMATCH",
  "CATEGORY_CYCLE",
  "MISSING_PRODUCT_REFERENCE",
  "MISSING_ASSET_REFERENCE",
  "MISSING_DESIGN_VARIANT",
  "INVALID_DESIGN_SELECTION",
  "TELEGRAM_DESTINATION_INVALID",
  "TELEGRAM_ROUTE_INVALID",
  "MISSING_TELEGRAM_ROUTE",
  "WORDPRESS_TARGET_MISMATCH",
  "TARGET_ENVIRONMENT_MISMATCH",
  "READINESS_OWNER_INVALID",
  "READINESS_REQUIRED_CHECK_FAILED",
  "VARIANT_COMMERCIAL_NOT_PUBLISHABLE",
  "COMMERCIAL_PROVENANCE_INVALID",
  "REGULATED_REVIEW_GATE_MISSING"
];

const COMMERCIAL_TRUSTED_PROVENANCE = new Set([
  "user_input",
  "csv_import",
  "xlsx_import",
  "operator_review",
  "external_document"
]);

function add(errors, code, path, message) {
  errors.push({ code, path, message });
}

function getAssetKey(asset) {
  return asset?.assetId ?? asset?.artifactId ?? null;
}

function buildAssetKeys(spec, errors) {
  const keys = new Set();
  for (const [index, asset] of (spec.assetRegistry?.assets ?? []).entries()) {
    const key = getAssetKey(asset);
    if (!key) continue;
    if (keys.has(key)) {
      add(errors, "DUPLICATE_ID", `/assetRegistry/assets/${index}`, `Duplicate asset/artifact id: ${key}`);
    }
    keys.add(key);
  }
  return keys;
}

function checkUnique(items, idField, scope, path, errors) {
  const ids = new Set();
  for (const [index, item] of (items ?? []).entries()) {
    const id = item?.[idField];
    if (!id) continue;
    if (ids.has(id)) {
      add(errors, "DUPLICATE_ID", `${path}/${index}/${idField}`, `Duplicate ${scope} id: ${id}`);
    }
    ids.add(id);
  }
  return ids;
}

function checkAssetRef(id, path, keys, errors) {
  if (id && !keys.has(id)) {
    add(errors, "MISSING_ASSET_REFERENCE", path, `Missing asset/artifact reference: ${id}`);
  }
}

function checkFactAssets(fact, path, keys, errors) {
  if (!fact || typeof fact !== "object") return;
  checkAssetRef(fact.provenance?.assetId, `${path}/provenance/assetId`, keys, errors);
  for (const [index, evidenceId] of (fact.verification?.evidenceArtifactIds ?? []).entries()) {
    checkAssetRef(evidenceId, `${path}/verification/evidenceArtifactIds/${index}`, keys, errors);
  }
}

function escapeJsonPointerSegment(segment) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isAssetReferenceKey(key) {
  return key === "assetId" || key === "artifactId" || key.endsWith("AssetId") || key.endsWith("ArtifactId");
}

function isAssetReferenceListKey(key) {
  return key.endsWith("AssetIds") || key.endsWith("ArtifactIds");
}

function checkAllAssetReferences(value, path, keys, errors) {
  if (!value || typeof value !== "object") return;
  if (path.startsWith("/assetRegistry/assets/")) return;

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      checkAllAssetReferences(entry, `${path}/${index}`, keys, errors);
    }
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}/${escapeJsonPointerSegment(key)}`;
    if (typeof entry === "string" && isAssetReferenceKey(key)) {
      checkAssetRef(entry, entryPath, keys, errors);
      continue;
    }
    if (Array.isArray(entry) && isAssetReferenceListKey(key)) {
      for (const [index, id] of entry.entries()) {
        if (typeof id === "string") {
          checkAssetRef(id, `${entryPath}/${index}`, keys, errors);
        }
      }
    }
    checkAllAssetReferences(entry, entryPath, keys, errors);
  }
}

function checkCommercialValue(value, path, keys, errors) {
  if (!value || typeof value !== "object") return;
  checkFactAssets(value.quantity, `${path}/quantity`, keys, errors);
  checkAssetRef(value.provenance?.assetId, `${path}/provenance/assetId`, keys, errors);

  if (!value.publishAllowed) return;

  const sourceType = value.provenance?.sourceType;
  if (!COMMERCIAL_TRUSTED_PROVENANCE.has(sourceType)) {
    add(errors, "COMMERCIAL_PROVENANCE_INVALID", `${path}/provenance/sourceType`, `Commercial value cannot publish provenance: ${sourceType}`);
  }
  if (value.visibility === "unknown" || value.status === "unknown") {
    add(errors, "COMMERCIAL_PROVENANCE_INVALID", path, "Commercial value cannot publish unknown visibility/status");
  }
}

function isPublishableFact(fact) {
  return Boolean(
    fact &&
      fact.publishAllowed === true &&
      fact.status === "verified" &&
      fact.value !== null &&
      COMMERCIAL_TRUSTED_PROVENANCE.has(fact.provenance?.sourceType)
  );
}

function checkPublishableCommercialOverride(value, path, keys, errors) {
  if (!value) return;
  checkCommercialValue(value, path, keys, errors);
  if (value.publishAllowed !== true) {
    add(errors, "VARIANT_COMMERCIAL_NOT_PUBLISHABLE", path, "Ready/published variant override is not publishable");
  }
}

function checkCategoryGraph(categories, productIds, keys, errors) {
  const byId = new Map();
  for (const [index, category] of categories.entries()) {
    if (category?.id) byId.set(category.id, { category, index });
  }

  for (const [index, category] of categories.entries()) {
    const path = `/catalog/categories/${index}`;
    for (const [assetIndex, assetId] of (category.assetIds ?? []).entries()) {
      checkAssetRef(assetId, `${path}/assetIds/${assetIndex}`, keys, errors);
    }
    checkFactAssets(category.description, `${path}/description`, keys, errors);
    for (const [productIndex, productId] of (category.productIds ?? []).entries()) {
      if (!productIds.has(productId)) {
        add(errors, "MISSING_PRODUCT_REFERENCE", `${path}/productIds/${productIndex}`, `Missing product reference: ${productId}`);
      }
    }
    if (category.parentId && !byId.has(category.parentId)) {
      add(errors, "MISSING_CATEGORY_PARENT", `${path}/parentId`, `Missing category parent: ${category.parentId}`);
    }

    const visited = new Set();
    let cursor = category;
    while (cursor?.parentId) {
      if (visited.has(cursor.id)) {
        add(errors, "CATEGORY_CYCLE", `${path}/parentId`, `Category parent cycle includes: ${cursor.id}`);
        break;
      }
      visited.add(cursor.id);
      cursor = byId.get(cursor.parentId)?.category;
    }

    const expectedPath = [];
    const pathVisited = new Set();
    cursor = category;
    while (cursor) {
      if (pathVisited.has(cursor.id)) break;
      pathVisited.add(cursor.id);
      expectedPath.unshift(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId)?.category : null;
    }
    if (expectedPath.length > 0 && JSON.stringify(category.path) !== JSON.stringify(expectedPath)) {
      add(errors, "CATEGORY_PATH_MISMATCH", `${path}/path`, `Category path must match parent chain: ${expectedPath.join("/")}`);
    }
  }
}

function checkCatalog(spec, keys, errors) {
  const catalog = spec.catalog;
  if (!catalog) return;

  const categories = catalog.categories ?? [];
  const products = catalog.products ?? [];
  const productIds = checkUnique(products, "id", "product", "/catalog/products", errors);
  checkUnique(categories, "id", "category", "/catalog/categories", errors);
  checkCategoryGraph(categories, productIds, keys, errors);

  for (const [index, assetId] of (catalog.importAssetIds ?? []).entries()) {
    checkAssetRef(assetId, `/catalog/importAssetIds/${index}`, keys, errors);
  }

  for (const [productIndex, product] of products.entries()) {
    const path = `/catalog/products/${productIndex}`;
    for (const [assetIndex, assetId] of (product.photoAssetIds ?? []).entries()) {
      checkAssetRef(assetId, `${path}/photoAssetIds/${assetIndex}`, keys, errors);
    }
    checkCommercialValue(product.price, `${path}/price`, keys, errors);
    checkCommercialValue(product.stock, `${path}/stock`, keys, errors);
    checkFactAssets(product.minOrder, `${path}/minOrder`, keys, errors);

    checkUnique(product.variants ?? [], "id", "variant", `${path}/variants`, errors);
    for (const [variantIndex, variant] of (product.variants ?? []).entries()) {
      const variantPath = `${path}/variants/${variantIndex}`;
      for (const [assetIndex, assetId] of (variant.photoAssetIds ?? []).entries()) {
        checkAssetRef(assetId, `${variantPath}/photoAssetIds/${assetIndex}`, keys, errors);
      }
      checkCommercialValue(variant.priceOverride, `${variantPath}/priceOverride`, keys, errors);
      checkCommercialValue(variant.stock, `${variantPath}/stock`, keys, errors);
      checkFactAssets(variant.minOrder, `${variantPath}/minOrder`, keys, errors);
      checkFactAssets(variant.packaging, `${variantPath}/packaging`, keys, errors);

      if (["ready", "published"].includes(variant.publicationStatus)) {
        checkPublishableCommercialOverride(variant.priceOverride, `${variantPath}/priceOverride`, keys, errors);
        checkPublishableCommercialOverride(variant.stock, `${variantPath}/stock`, keys, errors);
        if (variant.minOrder && !isPublishableFact(variant.minOrder)) {
          add(errors, "VARIANT_COMMERCIAL_NOT_PUBLISHABLE", `${variantPath}/minOrder`, "Ready/published variant minimum order is not publishable");
        }
      }
    }
  }
}

function checkBrand(spec, keys, errors) {
  const brand = spec.brand;
  if (!brand) return;
  checkAssetRef(brand.logoAssetId, "/brand/logoAssetId", keys, errors);
  for (const [index, assetId] of (brand.designReferenceAssetIds ?? []).entries()) {
    checkAssetRef(assetId, `/brand/designReferenceAssetIds/${index}`, keys, errors);
  }
  for (const [index, assetId] of (brand.documentAssetIds ?? []).entries()) {
    checkAssetRef(assetId, `/brand/documentAssetIds/${index}`, keys, errors);
  }
}

function checkDesign(spec, keys, errors) {
  const design = spec.design;
  if (!design) return;
  const prototypes = design.prototypes ?? [];
  const byVariant = new Map();
  for (const [index, prototype] of prototypes.entries()) {
    if (prototype.variantId) byVariant.set(prototype.variantId, { prototype, index });
    checkAssetRef(prototype.prototypeArtifactId, `/design/prototypes/${index}/prototypeArtifactId`, keys, errors);
    checkAssetRef(prototype.screenshotArtifactId, `/design/prototypes/${index}/screenshotArtifactId`, keys, errors);
  }
  if (!design.selectedVariantId) return;
  const selected = byVariant.get(design.selectedVariantId);
  if (!selected) {
    add(errors, "MISSING_DESIGN_VARIANT", "/design/selectedVariantId", `Missing selected design variant: ${design.selectedVariantId}`);
    return;
  }
  if (!["selected", "approved"].includes(selected.prototype.status)) {
    add(errors, "INVALID_DESIGN_SELECTION", `/design/prototypes/${selected.index}/status`, "Selected design prototype must be selected or approved");
  }
}

function checkTelegram(spec, errors) {
  const telegram = spec.integrations?.telegram;
  if (!telegram) return;
  const sites = checkUnique(spec.network?.sites ?? [], "id", "site", "/network/sites", errors);
  const regions = checkUnique(spec.regions ?? [], "id", "region", "/regions", errors);
  const destinations = new Map();

  for (const [index, destination] of (telegram.destinations ?? []).entries()) {
    if (destination.id) destinations.set(destination.id, { destination, index });
    if (destination.enabled && !destination.secretRef) {
      add(errors, "TELEGRAM_DESTINATION_INVALID", `/integrations/telegram/destinations/${index}/secretRef`, "Enabled Telegram destination requires secretRef");
    }
  }

  for (const [index, route] of (telegram.routing ?? []).entries()) {
    const path = `/integrations/telegram/routing/${index}`;
    if (route.projectId !== spec.projectId) {
      add(errors, "TELEGRAM_ROUTE_INVALID", `${path}/projectId`, "Telegram route projectId must match SiteSpec projectId");
    }
    if (!sites.has(route.siteId)) {
      add(errors, "TELEGRAM_ROUTE_INVALID", `${path}/siteId`, `Telegram route references missing site: ${route.siteId}`);
    }
    if (route.regionId && !regions.has(route.regionId)) {
      add(errors, "TELEGRAM_ROUTE_INVALID", `${path}/regionId`, `Telegram route references missing region: ${route.regionId}`);
    }
    if (!destinations.has(route.destinationId)) {
      add(errors, "TELEGRAM_ROUTE_INVALID", `${path}/destinationId`, `Telegram route references missing destination: ${route.destinationId}`);
    }
  }

  for (const [formIndex, form] of (spec.leadForms ?? []).entries()) {
    if (form.publicationStatus !== "approved") continue;
    for (const [destinationIndex, destinationId] of (form.destinationIds ?? []).entries()) {
      const destinationEntry = destinations.get(destinationId);
      if (!destinationEntry?.destination.enabled || !destinationEntry.destination.secretRef) {
        add(errors, "TELEGRAM_DESTINATION_INVALID", `/leadForms/${formIndex}/destinationIds/${destinationIndex}`, `Lead form destination is missing, disabled, or has no secretRef: ${destinationId}`);
        continue;
      }
      const hasRoute = (telegram.routing ?? []).some(
        (route) => route.projectId === spec.projectId && route.destinationId === destinationId && sites.has(route.siteId)
      );
      if (!hasRoute) {
        add(errors, "MISSING_TELEGRAM_ROUTE", `/leadForms/${formIndex}/destinationIds/${destinationIndex}`, `Lead form destination has no route: ${destinationId}`);
      }
    }
  }
}

function fqdn(host) {
  if (!host?.domain) return null;
  return host.subdomain ? `${host.subdomain}.${host.domain}` : host.domain;
}

function checkWordPress(spec, errors) {
  const wpTarget = spec.integrations?.wordpress?.target;
  const deployment = spec.deployment;
  if (!wpTarget || !deployment?.target) return;

  let wpHost = null;
  try {
    wpHost = new URL(wpTarget.siteUrl).hostname;
  } catch {
    return;
  }
  const deploymentHost = fqdn(deployment.target.host);
  if (wpHost && deploymentHost && wpHost !== deploymentHost) {
    add(errors, "WORDPRESS_TARGET_MISMATCH", "/integrations/wordpress/target/siteUrl", `WordPress host ${wpHost} does not match deployment host ${deploymentHost}`);
  }
  if (deployment.environment === "staging" && deployment.target.kind !== "wordpress_staging") {
    add(errors, "TARGET_ENVIRONMENT_MISMATCH", "/deployment/target/kind", "Staging deployment must use wordpress_staging target");
  }
  if (deployment.environment === "production" && deployment.target.kind !== "wordpress_production") {
    add(errors, "TARGET_ENVIRONMENT_MISMATCH", "/deployment/target/kind", "Production deployment must use wordpress_production target");
  }
  for (const [index, site] of (spec.network?.sites ?? []).entries()) {
    const siteHost = fqdn(site.host);
    if (siteHost && deploymentHost && siteHost !== deploymentHost) {
      add(errors, "WORDPRESS_TARGET_MISMATCH", `/network/sites/${index}/host`, `Site host ${siteHost} does not match deployment host ${deploymentHost}`);
    }
  }
}

function checkReadiness(spec, errors) {
  const readiness = spec.readiness;
  if (!readiness) return;
  if (readiness.ownedBy !== "server") {
    add(errors, "READINESS_OWNER_INVALID", "/readiness/ownedBy", "Readiness must be server-owned");
  }
  for (const gateName of ["generation", "publish"]) {
    const gate = readiness[gateName];
    if (!gate || gate.status !== "passed") continue;
    for (const [index, check] of (gate.checks ?? []).entries()) {
      if (check.required && ["missing", "failed"].includes(check.status)) {
        add(errors, "READINESS_REQUIRED_CHECK_FAILED", `/readiness/${gateName}/checks/${index}/status`, "Passed readiness cannot contain required missing/failed checks");
      }
    }
  }
}

function checkRegulatedProducts(spec, errors) {
  const regulated = spec.compliance?.regulatedProducts;
  if (!regulated?.enabled || !regulated.legalReviewRequired || spec.documentStage !== "publish_ready") return;
  const hasGate = (spec.readiness?.publish?.checks ?? []).some(
    (check) => check.required && check.status === "passed" && ["regulated_product_review", "legal_review_approved"].includes(check.id)
  );
  if (!hasGate) {
    add(errors, "REGULATED_REVIEW_GATE_MISSING", "/compliance/regulatedProducts/legalReviewRequired", "Publish-ready regulated products require a passed legal/regulatory review gate");
  }
}

export function validateSiteSpecSemantics(spec) {
  const errors = [];
  const assetKeys = buildAssetKeys(spec, errors);

  checkAllAssetReferences(spec, "", assetKeys, errors);
  checkBrand(spec, assetKeys, errors);
  checkCatalog(spec, assetKeys, errors);
  checkDesign(spec, assetKeys, errors);
  checkTelegram(spec, errors);
  checkWordPress(spec, errors);
  checkReadiness(spec, errors);
  checkRegulatedProducts(spec, errors);

  return errors;
}
