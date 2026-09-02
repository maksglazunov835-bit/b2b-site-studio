export const JOB_SPEC_SEMANTIC_ERROR_CODES = [
  "ACTION_CAPABILITY_MISMATCH",
  "GITHUB_PUSH_BINDING_MISMATCH",
  "GITHUB_PR_BINDING_MISMATCH",
  "ARTIFACT_DESTINATION_MISSING",
  "WORDPRESS_DESTINATION_MISMATCH",
  "INVALID_GIT_REF",
  "GIT_WORKFLOW_RETURNS_MISMATCH",
  "NETWORK_ALLOWLIST_MISMATCH",
  "NETWORK_OPERATION_MISMATCH",
  "UNALLOWLISTED_NETWORK_DESTINATION",
  "REPOSITORY_BINDING_MISMATCH",
  "FORBIDDEN_ACTION_CONFLICT",
  "VALIDATION_CHECK_INVALID",
  "OUTPUT_PATH_NOT_ALLOWED",
  "VALIDATION_PATH_NOT_ALLOWED"
];

const ACTION_CAPABILITIES = {
  read_files: ["file_read"],
  write_files: ["file_write"],
  create_branch: ["git"],
  create_worktree: ["git"],
  run_registered_validation: ["codex"],
  request_approval: ["codex"],
  create_artifact: ["file_write"],
  upload_artifact: ["artifact_upload"],
  git_commit: ["git"],
  git_push_feature_branch: ["git"],
  create_or_update_pull_request: ["github_pr"],
  wordpress_stage: ["wordpress_api"],
  wordpress_publish: ["wordpress_api"]
};

const NETWORK_RULES = {
  github_git: { protocol: "ssh", host: "github.com", port: 22, operation: "git_push" },
  github_api: { protocol: "https", host: "api.github.com", port: 443, operation: "pr_create_update" },
  artifact_upload: { protocol: "https", host: "artifact-storage.local", port: 443, operation: "artifact_upload" },
  wordpress_staging: { protocol: "https", host: "wordpress-target.local", port: 443, operation: "wordpress_stage" },
  wordpress_production: { protocol: "https", host: "wordpress-target.local", port: 443, operation: "wordpress_publish" }
};

const VALIDATION_REGISTRY = {
  file_exists: new Set(["path", "mustExist"]),
  npm_lint: new Set(["scope"]),
  npm_build: new Set(["scope"]),
  git_diff_check: new Set(["scope"]),
  static_html_exists: new Set(["htmlPath", "cssPath"])
};

function add(errors, code, path, message) {
  errors.push({ code, path, message });
}

function hasCapability(job, capability) {
  return (job.allowedCapabilities ?? []).includes(capability);
}

function hasAction(job, action) {
  return (job.allowedActions ?? []).includes(action);
}

function getDestinations(job, purpose) {
  return (job.sandbox?.networkAllowlist ?? []).filter((destination) => destination.purpose === purpose);
}

function hasControlChars(value) {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function isSafeGitBranchRef(ref) {
  if (typeof ref !== "string") return false;
  if (!ref.startsWith("codex/")) return false;
  if (ref === "codex/" || ref.endsWith("/") || ref.endsWith(".")) return false;
  if (hasControlChars(ref) || /[\\ ~^:?*[\]]/.test(ref)) return false;
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) return false;
  const segments = ref.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith(".") || segment.endsWith(".lock"))) return false;
  return !["main", "master"].includes(ref);
}

function checkActionCapabilities(job, errors) {
  const capabilities = new Set(job.allowedCapabilities ?? []);
  for (const action of job.allowedActions ?? []) {
    for (const capability of ACTION_CAPABILITIES[action] ?? []) {
      if (!capabilities.has(capability)) {
        add(errors, "ACTION_CAPABILITY_MISMATCH", "/allowedCapabilities", `Action ${action} requires capability ${capability}`);
      }
    }
  }
}

function checkForbiddenConflicts(job, errors) {
  const forbidden = new Set(job.forbiddenActions ?? []);
  for (const action of job.allowedActions ?? []) {
    if (forbidden.has(action)) {
      add(errors, "FORBIDDEN_ACTION_CONFLICT", "/forbiddenActions", `Action ${action} is both allowed and forbidden`);
    }
  }
}

function checkNetworkDestinationShape(job, errors) {
  for (const [index, destination] of (job.sandbox?.networkAllowlist ?? []).entries()) {
    const rule = NETWORK_RULES[destination.purpose];
    const path = `/sandbox/networkAllowlist/${index}`;
    if (!rule) {
      add(errors, "UNALLOWLISTED_NETWORK_DESTINATION", `${path}/purpose`, `Unknown network purpose: ${destination.purpose}`);
      continue;
    }
    if (destination.protocol !== rule.protocol || destination.host !== rule.host || destination.port !== rule.port) {
      add(errors, "NETWORK_ALLOWLIST_MISMATCH", path, `Network destination shape does not match purpose ${destination.purpose}`);
    }
    const operations = destination.allowedOperations ?? [];
    if (operations.length !== 1 || operations[0] !== rule.operation) {
      add(
        errors,
        "NETWORK_OPERATION_MISMATCH",
        `${path}/allowedOperations`,
        `Network purpose ${destination.purpose} allows only operation ${rule.operation}`
      );
    }
  }
}

function checkGitHubDestination(job, purpose, code, errors) {
  const destinations = getDestinations(job, purpose);
  if (destinations.length === 0) {
    add(errors, code, "/sandbox/networkAllowlist", `Missing ${purpose} destination`);
    return;
  }
  for (const [index, destination] of destinations.entries()) {
    const binding = destination.binding ?? {};
    const path = `/sandbox/networkAllowlist/${index}/binding`;
    if (binding.repositoryIdentifier !== job.repository.identifier) {
      add(errors, code, `${path}/repositoryIdentifier`, `${purpose} repositoryIdentifier mismatch`);
    }
    if (binding.providerRepositoryId !== job.repository.providerRepositoryId) {
      add(errors, code, `${path}/providerRepositoryId`, `${purpose} providerRepositoryId mismatch`);
    }
    if (binding.originUrl !== job.repository.originUrl) {
      add(errors, code, `${path}/originUrl`, `${purpose} originUrl mismatch`);
    }
    if (binding.targetBranch !== job.gitWorkflow.targetBranch) {
      add(errors, code, `${path}/targetBranch`, `${purpose} targetBranch mismatch`);
    }
  }
}

function checkGitHubWorkflow(job, errors) {
  if (job.gitWorkflow?.targetBranch && !isSafeGitBranchRef(job.gitWorkflow.targetBranch)) {
    add(errors, "INVALID_GIT_REF", "/gitWorkflow/targetBranch", `Unsafe git branch ref: ${job.gitWorkflow.targetBranch}`);
  }

  if (hasAction(job, "git_push_feature_branch")) {
    if (!hasCapability(job, "git")) {
      add(errors, "ACTION_CAPABILITY_MISMATCH", "/allowedCapabilities", "git_push_feature_branch requires git capability");
    }
    if (job.sandbox?.networkAccess !== "allowlisted") {
      add(errors, "GITHUB_PUSH_BINDING_MISMATCH", "/sandbox/networkAccess", "git push requires allowlisted network");
    }
    checkGitHubDestination(job, "github_git", "GITHUB_PUSH_BINDING_MISMATCH", errors);
  }

  if (hasAction(job, "create_or_update_pull_request")) {
    if (!hasCapability(job, "github_pr")) {
      add(errors, "ACTION_CAPABILITY_MISMATCH", "/allowedCapabilities", "create_or_update_pull_request requires github_pr capability");
    }
    if (job.sandbox?.networkAccess !== "allowlisted") {
      add(errors, "GITHUB_PR_BINDING_MISMATCH", "/sandbox/networkAccess", "PR update requires allowlisted network");
    }
    checkGitHubDestination(job, "github_api", "GITHUB_PR_BINDING_MISMATCH", errors);
  }
}

function checkArtifactUpload(job, errors) {
  if (!hasAction(job, "upload_artifact")) return;
  if (!hasCapability(job, "artifact_upload")) {
    add(errors, "ACTION_CAPABILITY_MISMATCH", "/allowedCapabilities", "upload_artifact requires artifact_upload capability");
  }
  const destinations = getDestinations(job, "artifact_upload");
  if (!destinations.some((destination) => destination.binding?.artifactTargetId)) {
    add(errors, "ARTIFACT_DESTINATION_MISSING", "/sandbox/networkAllowlist", "upload_artifact requires artifact_upload destination with artifactTargetId");
  }
}

function checkWordPressActions(job, errors) {
  if (hasAction(job, "wordpress_stage")) {
    if (!hasCapability(job, "wordpress_api")) {
      add(errors, "ACTION_CAPABILITY_MISMATCH", "/allowedCapabilities", "wordpress_stage requires wordpress_api capability");
    }
    const stagingTargets = new Set(getDestinations(job, "wordpress_staging").map((destination) => destination.binding?.wordpressTargetId).filter(Boolean));
    if (stagingTargets.size === 0) {
      add(errors, "WORDPRESS_DESTINATION_MISMATCH", "/sandbox/networkAllowlist", "wordpress_stage requires wordpress_staging destination");
    }
    if (job.inputs?.payload?.environment === "staging" && job.inputs.payload.wordpressTargetId && !stagingTargets.has(job.inputs.payload.wordpressTargetId)) {
      add(errors, "WORDPRESS_DESTINATION_MISMATCH", "/inputs/payload/wordpressTargetId", "staging payload target must match wordpress_staging destination");
    }
  }

  if (hasAction(job, "wordpress_publish")) {
    if (!hasCapability(job, "wordpress_api")) {
      add(errors, "ACTION_CAPABILITY_MISMATCH", "/allowedCapabilities", "wordpress_publish requires wordpress_api capability");
    }
    const productionTargets = new Set(getDestinations(job, "wordpress_production").map((destination) => destination.binding?.wordpressTargetId).filter(Boolean));
    if (productionTargets.size === 0) {
      add(errors, "WORDPRESS_DESTINATION_MISMATCH", "/sandbox/networkAllowlist", "wordpress_publish requires wordpress_production destination");
    }
    if (job.inputs?.payload?.environment === "production" && job.inputs.payload.wordpressTargetId && !productionTargets.has(job.inputs.payload.wordpressTargetId)) {
      add(errors, "WORDPRESS_DESTINATION_MISMATCH", "/inputs/payload/wordpressTargetId", "production payload target must match wordpress_production destination");
    }
  }
}

function collectPayloadExecutionHosts(value, hosts = []) {
  if (!value || typeof value !== "object") return hosts;
  if (Array.isArray(value)) {
    for (const item of value) collectPayloadExecutionHosts(item, hosts);
    return hosts;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /^(executionTargetUrl|executionTargetHost|networkHost|uploadUrl)$/i.test(key)) {
      try {
        hosts.push(entry.includes("://") ? new URL(entry).hostname : entry);
      } catch {
        hosts.push(entry);
      }
    } else if (entry && typeof entry === "object") {
      collectPayloadExecutionHosts(entry, hosts);
    }
  }
  return hosts;
}

function checkPayloadNetworkHosts(job, errors) {
  const allowedHosts = new Set((job.sandbox?.networkAllowlist ?? []).map((destination) => destination.host));
  for (const host of collectPayloadExecutionHosts(job.inputs?.payload)) {
    if (!allowedHosts.has(host)) {
      add(errors, "UNALLOWLISTED_NETWORK_DESTINATION", "/inputs/payload", `Payload selected network host is not allowlisted: ${host}`);
    }
  }
}

function checkRepositoryBindings(job, errors) {
  for (const [index, destination] of (job.sandbox?.networkAllowlist ?? []).entries()) {
    if (!["github_git", "github_api"].includes(destination.purpose)) continue;
    const binding = destination.binding ?? {};
    if (
      binding.repositoryIdentifier !== job.repository.identifier ||
      binding.providerRepositoryId !== job.repository.providerRepositoryId ||
      binding.originUrl !== job.repository.originUrl
    ) {
      add(errors, "REPOSITORY_BINDING_MISMATCH", `/sandbox/networkAllowlist/${index}/binding`, `${destination.purpose} binding must match top-level repository`);
    }
  }
}

function checkGitWorkflowReturns(job, errors) {
  const returns = new Set(job.gitWorkflow?.returns ?? []);
  const hasAnyGitResultAction = ["git_commit", "git_push_feature_branch", "create_or_update_pull_request"].some((action) => hasAction(job, action));
  if (hasAnyGitResultAction && (!returns.has("commit_sha") || !returns.has("branch_name"))) {
    add(errors, "GIT_WORKFLOW_RETURNS_MISMATCH", "/gitWorkflow/returns", "Git result actions must return commit_sha and branch_name");
  }
  if (hasAction(job, "create_or_update_pull_request") && !returns.has("pull_request_url")) {
    add(errors, "GIT_WORKFLOW_RETURNS_MISMATCH", "/gitWorkflow/returns", "PR action must return pull_request_url");
  }
  if (!hasAction(job, "create_or_update_pull_request") && returns.has("pull_request_url")) {
    add(errors, "GIT_WORKFLOW_RETURNS_MISMATCH", "/gitWorkflow/returns", "pull_request_url is only valid for PR actions");
  }
}

function containsAny(value, characters) {
  return characters.some((character) => value.includes(character));
}

function isPosixSafePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !/^[A-Za-z]:/.test(path) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !/(^|\/)\.\.?(\/|$)/.test(path) &&
    !path.includes("//") &&
    !containsAny(path, ["*", "?", "[", "]", "{", "}", "!"]) &&
    !hasControlChars(path)
  );
}

function isPosixSafeGlob(glob) {
  return (
    typeof glob === "string" &&
    glob.length > 0 &&
    !/^[A-Za-z]:/.test(glob) &&
    !glob.startsWith("/") &&
    !glob.includes("\\") &&
    !glob.includes(":") &&
    !/(^|\/)\.\.?(\/|$)/.test(glob) &&
    !glob.includes("//") &&
    !containsAny(glob, ["?", "[", "]", "{", "}", "!"]) &&
    !hasControlChars(glob)
  );
}

function globToRegExp(glob) {
  if (!isPosixSafeGlob(glob)) return null;
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += /[\\^$+.()|]/.test(char) ? `\\${char}` : char;
  }
  source += "$";
  return new RegExp(source);
}

function isCoveredByAllowedPaths(path, allowedGlobs) {
  if (!isPosixSafePath(path)) return false;
  return allowedGlobs.some((glob) => globToRegExp(glob)?.test(path));
}

function checkAllowedPaths(job, errors) {
  const allowedGlobs = (job.allowedPaths ?? []).filter(isPosixSafeGlob);
  for (const [index, output] of (job.expectedOutputManifest ?? []).entries()) {
    if (!isCoveredByAllowedPaths(output.path, allowedGlobs)) {
      add(
        errors,
        "OUTPUT_PATH_NOT_ALLOWED",
        `/expectedOutputManifest/${index}/path`,
        `Expected output path is not a concrete path covered by allowedPaths: ${output.path}`
      );
    }
  }

  for (const [checkIndex, check] of (job.validationChecks ?? []).entries()) {
    for (const key of ["path", "htmlPath", "cssPath"]) {
      const path = check.parameters?.[key];
      if (path === undefined) continue;
      if (!isCoveredByAllowedPaths(path, allowedGlobs)) {
        add(
          errors,
          "VALIDATION_PATH_NOT_ALLOWED",
          `/validationChecks/${checkIndex}/parameters/${key}`,
          `Validation path is not a concrete path covered by allowedPaths: ${path}`
        );
      }
    }
  }
}

function checkValidationRegistry(job, errors) {
  for (const [index, check] of (job.validationChecks ?? []).entries()) {
    const allowedParams = VALIDATION_REGISTRY[check.id];
    const path = `/validationChecks/${index}`;
    if (!allowedParams || check.shellMode !== false) {
      add(errors, "VALIDATION_CHECK_INVALID", path, `Unknown or shell-enabled validation check: ${check.id}`);
      continue;
    }
    for (const key of Object.keys(check.parameters ?? {})) {
      if (!allowedParams.has(key)) {
        add(errors, "VALIDATION_CHECK_INVALID", `${path}/parameters/${key}`, `Unexpected validation parameter ${key}`);
      }
    }
    for (const key of ["path", "htmlPath", "cssPath"]) {
      if (key in (check.parameters ?? {}) && !isPosixSafePath(check.parameters[key])) {
        add(errors, "VALIDATION_CHECK_INVALID", `${path}/parameters/${key}`, `Unsafe validation path ${check.parameters[key]}`);
      }
    }
    if ("scope" in (check.parameters ?? {}) && check.parameters.scope !== "workspace") {
      add(errors, "VALIDATION_CHECK_INVALID", `${path}/parameters/scope`, "Validation scope must be workspace");
    }
  }
}

export function validateJobSpecSemantics(job) {
  const errors = [];

  checkActionCapabilities(job, errors);
  checkForbiddenConflicts(job, errors);
  checkNetworkDestinationShape(job, errors);
  checkGitHubWorkflow(job, errors);
  checkArtifactUpload(job, errors);
  checkWordPressActions(job, errors);
  checkPayloadNetworkHosts(job, errors);
  checkRepositoryBindings(job, errors);
  checkGitWorkflowReturns(job, errors);
  checkValidationRegistry(job, errors);
  checkAllowedPaths(job, errors);

  return errors;
}
