export const SITE_SPEC_SEMANTIC_ERROR_CODES = [
  "DUPLICATE_ID",
  "MISSING_CATEGORY_PARENT",
  "CATEGORY_PATH_MISMATCH",
  "CATEGORY_CYCLE",
  "MISSING_REGION_REFERENCE",
  "MISSING_CATEGORY_REFERENCE",
  "MISSING_PRODUCT_REFERENCE",
  "MISSING_VARIANT_REFERENCE",
  "VARIANT_PRODUCT_MISMATCH",
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

function buildUniqueIndex(items, idField, scope, path, errors) {
  const byId = new Map();
  for (const [index, item] of (items ?? []).entries()) {
    const id = item?.[idField];
    if (!id) continue;
    if (byId.has(id)) {
      add(errors, "DUPLICATE_ID", `${path}/${index}/${idField}`, `Duplicate ${scope} id: ${id}`);
      continue;
    }
    byId.set(id, { value: item, index });
  }
  return byId;
}

function buildStructuralIndexes(spec, errors) {
  const sites = buildUniqueIndex(spec.network?.sites, "id", "site", "/network/sites", errors);
  const regions = buildUniqueIndex(spec.regions, "id", "region", "/regions", errors);
  const categories = buildUniqueIndex(spec.catalog?.categories, "id", "category", "/catalog/categories", errors);
  const products = buildUniqueIndex(spec.catalog?.products, "id", "product", "/catalog/products", errors);
  const leadForms = buildUniqueIndex(spec.leadForms, "id", "lead form", "/leadForms", errors);
  const telegramDestinations = buildUniqueIndex(
    spec.integrations?.telegram?.destinations,
    "id",
    "Telegram destination",
    "/integrations/telegram/destinations",
    errors
  );
  const designPrototypes = buildUniqueIndex(
    spec.design?.prototypes,
    "variantId",
    "design variant",
    "/design/prototypes",
    errors
  );
  const variantsByProduct = new Map();
  const variantOwners = new Map();

  for (const [productIndex, product] of (spec.catalog?.products ?? []).entries()) {
    const variants = buildUniqueIndex(
      product.variants,
      "id",
      "variant",
      `/catalog/products/${productIndex}/variants`,
      errors
    );
    if (product.id && !variantsByProduct.has(product.id)) {
      variantsByProduct.set(product.id, variants);
    }
    for (const variantId of variants.keys()) {
      const owners = variantOwners.get(variantId) ?? new Set();
      if (product.id) owners.add(product.id);
      variantOwners.set(variantId, owners);
    }
  }

  return {
    sites,
    regions,
    categories,
    products,
    variantsByProduct,
    variantOwners,
    leadForms,
    telegramDestinations,
    designPrototypes
  };
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

function checkCommercialFact(value, path, keys, errors, kind) {
  if (!value || typeof value !== "object") return;

  if (kind === "minimum_order") {
    checkFactAssets(value, path, keys, errors);
  } else {
    checkFactAssets(value.quantity, `${path}/quantity`, keys, errors);
    checkAssetRef(value.provenance?.assetId, `${path}/provenance/assetId`, keys, errors);
  }

  if (!value.publishAllowed) return;

  const sourceType = value.provenance?.sourceType;
  const minimumOrderInvalid =
    kind === "minimum_order" &&
    (value.value === null || value.status !== "verified" || !value.verification || !value.verifiedAt);
  const priceOrStockInvalid = kind !== "minimum_order" && (value.visibility === "unknown" || value.status === "unknown");

  if (!COMMERCIAL_TRUSTED_PROVENANCE.has(sourceType) || minimumOrderInvalid || priceOrStockInvalid) {
    add(
      errors,
      "COMMERCIAL_PROVENANCE_INVALID",
      path,
      `Publishable ${kind} requires a trusted source and a non-unknown verified value`
    );
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
  checkCommercialFact(value, path, keys, errors, "commercial_override");
  if (value.publishAllowed !== true) {
    add(errors, "VARIANT_COMMERCIAL_NOT_PUBLISHABLE", path, "Ready/published variant override is not publishable");
  }
}

function checkCategoryGraph(categories, productIds, keys, errors) {
  const byId = new Map();
  for (const [index, category] of categories.entries()) {
    if (category?.id && !byId.has(category.id)) byId.set(category.id, { category, index });
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

function checkCatalog(spec, indexes, keys, errors) {
  const catalog = spec.catalog;
  if (!catalog) return;

  const categories = catalog.categories ?? [];
  const products = catalog.products ?? [];
  checkCategoryGraph(categories, indexes.products, keys, errors);
  checkCommercialFact(catalog.minOrderPolicy, "/catalog/minOrderPolicy", keys, errors, "minimum_order");

  for (const [index, assetId] of (catalog.importAssetIds ?? []).entries()) {
    checkAssetRef(assetId, `/catalog/importAssetIds/${index}`, keys, errors);
  }

  for (const [productIndex, product] of products.entries()) {
    const path = `/catalog/products/${productIndex}`;
    for (const [assetIndex, assetId] of (product.photoAssetIds ?? []).entries()) {
      checkAssetRef(assetId, `${path}/photoAssetIds/${assetIndex}`, keys, errors);
    }
    checkCommercialFact(product.price, `${path}/price`, keys, errors, "price");
    checkCommercialFact(product.stock, `${path}/stock`, keys, errors, "stock");
    checkCommercialFact(product.minOrder, `${path}/minOrder`, keys, errors, "minimum_order");

    for (const [variantIndex, variant] of (product.variants ?? []).entries()) {
      const variantPath = `${path}/variants/${variantIndex}`;
      for (const [assetIndex, assetId] of (variant.photoAssetIds ?? []).entries()) {
        checkAssetRef(assetId, `${variantPath}/photoAssetIds/${assetIndex}`, keys, errors);
      }
      checkCommercialFact(variant.priceOverride, `${variantPath}/priceOverride`, keys, errors, "price");
      checkCommercialFact(variant.stock, `${variantPath}/stock`, keys, errors, "stock");
      checkCommercialFact(variant.minOrder, `${variantPath}/minOrder`, keys, errors, "minimum_order");
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

function checkReferenceList(ids, index, path, code, label, errors) {
  for (const [itemIndex, id] of (ids ?? []).entries()) {
    if (!index.has(id)) {
      add(errors, code, `${path}/${itemIndex}`, `Missing ${label} reference: ${id}`);
    }
  }
}

function checkProductVariantReference(entry, path, indexes, errors) {
  const productId = entry?.productId;
  if (!indexes.products.has(productId)) {
    add(errors, "MISSING_PRODUCT_REFERENCE", `${path}/productId`, `Missing product reference: ${productId}`);
    return;
  }

  const variantId = entry?.variantId;
  if (!variantId) return;
  if (indexes.variantsByProduct.get(productId)?.has(variantId)) return;

  if (indexes.variantOwners.has(variantId)) {
    add(
      errors,
      "VARIANT_PRODUCT_MISMATCH",
      `${path}/variantId`,
      `Variant ${variantId} does not belong to product ${productId}`
    );
    return;
  }
  add(errors, "MISSING_VARIANT_REFERENCE", `${path}/variantId`, `Missing variant reference: ${variantId}`);
}

function checkOverrideReferences(overrides, path, indexes, keys, errors) {
  if (!overrides) return;
  const scope = overrides.catalogScope;
  if (scope) {
    checkReferenceList(
      scope.includeCategoryIds,
      indexes.categories,
      `${path}/catalogScope/includeCategoryIds`,
      "MISSING_CATEGORY_REFERENCE",
      "category",
      errors
    );
    checkReferenceList(
      scope.excludeCategoryIds,
      indexes.categories,
      `${path}/catalogScope/excludeCategoryIds`,
      "MISSING_CATEGORY_REFERENCE",
      "category",
      errors
    );
    checkReferenceList(
      scope.includeProductIds,
      indexes.products,
      `${path}/catalogScope/includeProductIds`,
      "MISSING_PRODUCT_REFERENCE",
      "product",
      errors
    );
    checkReferenceList(
      scope.excludeProductIds,
      indexes.products,
      `${path}/catalogScope/excludeProductIds`,
      "MISSING_PRODUCT_REFERENCE",
      "product",
      errors
    );
  }

  checkCommercialFact(overrides.minOrderPolicy?.value, `${path}/minOrderPolicy/value`, keys, errors, "minimum_order");

  for (const [index, override] of (overrides.priceOverrides ?? []).entries()) {
    const overridePath = `${path}/priceOverrides/${index}`;
    checkProductVariantReference(override, overridePath, indexes, errors);
    checkCommercialFact(override.price, `${overridePath}/price`, keys, errors, "price");
  }
  for (const [index, override] of (overrides.regionalStock ?? []).entries()) {
    const overridePath = `${path}/regionalStock/${index}`;
    checkProductVariantReference(override, overridePath, indexes, errors);
    checkCommercialFact(override.stock, `${overridePath}/stock`, keys, errors, "stock");
    checkFactAssets(override.quantity, `${overridePath}/quantity`, keys, errors);
  }
}

function checkSiteRegionAndOverrideReferences(spec, indexes, keys, errors) {
  for (const [siteIndex, site] of (spec.network?.sites ?? []).entries()) {
    checkReferenceList(
      site.regionIds,
      indexes.regions,
      `/network/sites/${siteIndex}/regionIds`,
      "MISSING_REGION_REFERENCE",
      "region",
      errors
    );
    checkOverrideReferences(site.overrides, `/network/sites/${siteIndex}/overrides`, indexes, keys, errors);
  }
  for (const [regionIndex, region] of (spec.regions ?? []).entries()) {
    checkOverrideReferences(region.overrides, `/regions/${regionIndex}/overrides`, indexes, keys, errors);
  }
}

function checkDesign(spec, indexes, keys, errors) {
  const design = spec.design;
  if (!design) return;
  const prototypes = design.prototypes ?? [];
  for (const [index, prototype] of prototypes.entries()) {
    checkAssetRef(prototype.prototypeArtifactId, `/design/prototypes/${index}/prototypeArtifactId`, keys, errors);
    checkAssetRef(prototype.screenshotArtifactId, `/design/prototypes/${index}/screenshotArtifactId`, keys, errors);
  }
  if (!design.selectedVariantId) return;
  const selected = indexes.designPrototypes.get(design.selectedVariantId);
  if (!selected) {
    add(errors, "MISSING_DESIGN_VARIANT", "/design/selectedVariantId", `Missing selected design variant: ${design.selectedVariantId}`);
    return;
  }
  if (!["selected", "approved"].includes(selected.value.status)) {
    add(errors, "INVALID_DESIGN_SELECTION", `/design/prototypes/${selected.index}/status`, "Selected design prototype must be selected or approved");
  }
}

function getLeadFormContexts(form, formIndex, indexes, errors) {
  const scope = form.scope;
  if (!scope) {
    const siteContexts = [...indexes.sites.keys()].map((siteId) => ({ siteId, regionId: null }));
    return siteContexts.length > 0 ? siteContexts : [{ siteId: null, regionId: null }];
  }

  const path = `/leadForms/${formIndex}/scope`;
  if (scope.project) {
    if ((scope.siteIds ?? []).length > 0 || (scope.regionIds ?? []).length > 0) {
      add(errors, "TELEGRAM_ROUTE_INVALID", path, "Project-scoped lead form cannot also declare siteIds or regionIds");
    }
    return [{ siteId: null, regionId: null }];
  }

  if ((scope.siteIds ?? []).length === 0) {
    add(errors, "TELEGRAM_ROUTE_INVALID", `${path}/siteIds`, "Non-project lead form scope requires at least one siteId");
    return [];
  }

  const contexts = [];
  for (const [siteIndex, siteId] of (scope.siteIds ?? []).entries()) {
    const siteEntry = indexes.sites.get(siteId);
    if (!siteEntry) {
      add(errors, "TELEGRAM_ROUTE_INVALID", `${path}/siteIds/${siteIndex}`, `Lead form scope references missing site: ${siteId}`);
      continue;
    }
    if ((scope.regionIds ?? []).length === 0) {
      contexts.push({ siteId, regionId: null });
      continue;
    }
    for (const [regionIndex, regionId] of scope.regionIds.entries()) {
      if (!indexes.regions.has(regionId)) {
        add(errors, "MISSING_REGION_REFERENCE", `${path}/regionIds/${regionIndex}`, `Lead form scope references missing region: ${regionId}`);
        continue;
      }
      if (!(siteEntry.value.regionIds ?? []).includes(regionId)) {
        add(
          errors,
          "TELEGRAM_ROUTE_INVALID",
          `${path}/regionIds/${regionIndex}`,
          `Lead form region ${regionId} is not assigned to site ${siteId}`
        );
        continue;
      }
      contexts.push({ siteId, regionId });
    }
  }
  return contexts;
}

function routeFallbackRank(route, context) {
  if (route.siteId === null && route.regionId === null) return 2;
  if (context.siteId === null) return Number.POSITIVE_INFINITY;
  if (route.siteId !== context.siteId) return Number.POSITIVE_INFINITY;
  if (route.regionId === null) return 1;
  if (context.regionId !== null && route.regionId === context.regionId) return 0;
  return Number.POSITIVE_INFINITY;
}

function checkTelegram(spec, indexes, errors) {
  const telegram = spec.integrations?.telegram;
  const routes = telegram?.routing ?? [];
  const validRoutes = [];

  for (const [index, destination] of (telegram?.destinations ?? []).entries()) {
    if (destination.enabled && !destination.secretRef) {
      add(errors, "TELEGRAM_DESTINATION_INVALID", `/integrations/telegram/destinations/${index}/secretRef`, "Enabled Telegram destination requires secretRef");
    }
  }

  for (const [index, route] of routes.entries()) {
    const path = `/integrations/telegram/routing/${index}`;
    let valid = true;
    if (route.projectId !== spec.projectId) {
      add(errors, "TELEGRAM_ROUTE_INVALID", `${path}/projectId`, "Telegram route projectId must match SiteSpec projectId");
      valid = false;
    }

    let siteEntry = null;
    if (route.siteId === null) {
      if (route.regionId !== null) {
        add(errors, "TELEGRAM_ROUTE_INVALID", `${path}/regionId`, "Telegram route cannot declare regionId without siteId");
        valid = false;
      }
    } else {
      siteEntry = indexes.sites.get(route.siteId);
      if (!siteEntry) {
        add(errors, "TELEGRAM_ROUTE_INVALID", `${path}/siteId`, `Telegram route references missing site: ${route.siteId}`);
        valid = false;
      }
    }

    if (route.regionId !== null) {
      if (!indexes.regions.has(route.regionId)) {
        add(errors, "TELEGRAM_ROUTE_INVALID", `${path}/regionId`, `Telegram route references missing region: ${route.regionId}`);
        valid = false;
      } else if (siteEntry && !(siteEntry.value.regionIds ?? []).includes(route.regionId)) {
        add(
          errors,
          "TELEGRAM_ROUTE_INVALID",
          `${path}/regionId`,
          `Telegram route region ${route.regionId} is not assigned to site ${route.siteId}`
        );
        valid = false;
      }
    }

    const destinationEntry = indexes.telegramDestinations.get(route.destinationId);
    if (!destinationEntry?.value.enabled || !destinationEntry.value.secretRef) {
      add(
        errors,
        "TELEGRAM_DESTINATION_INVALID",
        `${path}/destinationId`,
        `Telegram route destination is missing, disabled, or has no secretRef: ${route.destinationId}`
      );
      valid = false;
    }
    if (valid) validRoutes.push(route);
  }

  for (const [formIndex, form] of (spec.leadForms ?? []).entries()) {
    if (form.publicationStatus !== "approved") continue;
    const contexts = getLeadFormContexts(form, formIndex, indexes, errors);
    if ((form.destinationIds ?? []).length === 0) {
      add(errors, "MISSING_TELEGRAM_ROUTE", `/leadForms/${formIndex}/destinationIds`, "Approved lead form requires a destination and applicable Telegram route");
      continue;
    }
    for (const [destinationIndex, destinationId] of (form.destinationIds ?? []).entries()) {
      const destinationEntry = indexes.telegramDestinations.get(destinationId);
      if (!destinationEntry?.value.enabled || !destinationEntry.value.secretRef) {
        add(errors, "TELEGRAM_DESTINATION_INVALID", `/leadForms/${formIndex}/destinationIds/${destinationIndex}`, `Lead form destination is missing, disabled, or has no secretRef: ${destinationId}`);
        continue;
      }
      for (const context of contexts) {
        const bestRank = Math.min(
          ...validRoutes
            .filter((route) => route.destinationId === destinationId && route.projectId === spec.projectId)
            .map((route) => routeFallbackRank(route, context))
        );
        if (!telegram?.enabled || !Number.isFinite(bestRank)) {
          add(
            errors,
            "MISSING_TELEGRAM_ROUTE",
            `/leadForms/${formIndex}/destinationIds/${destinationIndex}`,
            `Lead form destination ${destinationId} has no route for site ${context.siteId ?? "project"} and region ${context.regionId ?? "all"}`
          );
        }
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
  const indexes = buildStructuralIndexes(spec, errors);

  checkAllAssetReferences(spec, "", assetKeys, errors);
  checkBrand(spec, assetKeys, errors);
  checkCatalog(spec, indexes, assetKeys, errors);
  checkSiteRegionAndOverrideReferences(spec, indexes, assetKeys, errors);
  checkDesign(spec, indexes, assetKeys, errors);
  checkTelegram(spec, indexes, errors);
  checkWordPress(spec, errors);
  checkReadiness(spec, errors);
  checkRegulatedProducts(spec, errors);

  return errors;
}
