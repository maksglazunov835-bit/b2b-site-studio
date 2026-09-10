import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../../docs/contracts/design-proposal.schema.json' with { type: 'json' };
import jobSchema from '../../docs/contracts/design-job-astra.schema.json' with { type: 'json' };
import manifest from './adapter-manifest.json' with { type: 'json' };
import { boundedJson } from '../execution/bounds.mjs';
import { PersistenceError } from '../persistence/errors.mjs';
import { sha256Json } from '../persistence/canonical-json.mjs';
import { validWslAdmission, officialWslReady } from './admission.mjs';
import {
  editableDraftFromSiteSpec,
  normalizeEditableDraft,
  validateCanonicalSiteSpec,
} from '../persistence/site-spec.mjs';

export const DESIGN_POLICY = Object.freeze({
  leaseDurationMs: 10000,
  maxDurationMs: 180000,
  maxAttempts: 1,
  maxProviderInvocations: 1,
});
export const DESIGN_SETTINGS = Object.freeze({
  model: 'gpt-6-astra',
  effort: 'ultra',
  templateVersion: 'design_proposal@1',
  outputSchemaVersion: '1.0.0',
});
export const ADAPTER = Object.freeze({
  id: 'codex_design_exec',
  version: '1.1.0',
  sha256: manifest.sha256,
});
export const DESIGN_PREFLIGHT_CODES = [
  'CODEX_NOT_AVAILABLE',
  'CODEX_UNSUPPORTED_VERSION',
  'CODEX_LOGIN_REQUIRED',
  'CODEX_AUTH_UNSUPPORTED',
  'CODEX_SAFE_PROFILE_UNVERIFIED',
  'CODEX_MODEL_NOT_AVAILABLE',
  'CODEX_MODEL_QUERY_FAILED',
  'CODEX_MODEL_CAPABILITY_MISMATCH',
  'CODEX_ISOLATION_UNVERIFIED',
];
export const DESIGN_CODES = [
  ...DESIGN_PREFLIGHT_CODES,
  'CODEX_QUOTA',
  'CODEX_TIMEOUT',
  'CODEX_INVALID_OUTPUT',
  'CODEX_OUTPUT_LIMIT',
  'CODEX_PROCESS_FAILED',
  'INVOCATION_UNCERTAIN',
  'STOP_UNCONFIRMED',
];
const validate = new Ajv2020({ strict: true, allErrors: false }).compile(
  schema,
);
const validateJob = new Ajv2020({ strict: true }).compile(jobSchema);
const equal = (a, b) => sha256Json(a) === sha256Json(b);
export function designError(code, status = 422) {
  throw new PersistenceError(code, 'Design request rejected.', { status });
}
export function adapterCompatible(value) {
  return !!value && equal(value, ADAPTER);
}
export function assertRuntime(value) {
  if (
    !value ||
    Object.keys(value).filter(k => k !== 'admission').sort().join() !==
      'cliVersion,effort,model,modelSelection,policySha256,provider,status' ||
    !['codex', 'test_stub'].includes(value.provider) ||
    typeof value.cliVersion !== 'string' ||
    !/^[A-Za-z0-9.-]{1,32}$/.test(value.cliVersion) ||
    value.model !== DESIGN_SETTINGS.model ||
    value.effort !== DESIGN_SETTINGS.effort ||
    value.policySha256 !== ADAPTER.sha256 ||
    !['ready', ...DESIGN_PREFLIGHT_CODES].includes(value.status)
  )
    designError('INVALID_CODEX_RUNTIME');
  if (Object.hasOwn(value, 'admission') && (value.provider !== 'codex' || !validWslAdmission(value.admission)))
    designError('INVALID_CODEX_RUNTIME');
  if (value.provider === 'codex' && value.status === 'ready' && !officialWslReady(value))
    designError('INVALID_CODEX_RUNTIME');
  if (value.provider === 'test_stub' && value.cliVersion !== 'test-cli-1')
    designError('INVALID_CODEX_RUNTIME');
  const selection = value.modelSelection;
  if (selection !== null) {
    if (
      !selection ||
      Object.keys(selection).sort().join() !==
        'effort,resolvedModel,source,supportedReasoningEfforts' ||
      selection.source !==
        (value.provider === 'codex' ? 'official_model_list' : 'test_fixture') ||
      selection.resolvedModel !== DESIGN_SETTINGS.model ||
      selection.effort !== DESIGN_SETTINGS.effort ||
      !Array.isArray(selection.supportedReasoningEfforts) ||
      selection.supportedReasoningEfforts.length > 6 ||
      new Set(selection.supportedReasoningEfforts).size !==
        selection.supportedReasoningEfforts.length ||
      !selection.supportedReasoningEfforts.includes(DESIGN_SETTINGS.effort) ||
      selection.supportedReasoningEfforts.some(
        (e) => !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(e),
      )
    )
      designError('INVALID_CODEX_RUNTIME');
  } else if (value.status === 'ready') designError('INVALID_CODEX_RUNTIME');
  return value;
}
export function runtimeExecutable(runtime, {allowTest = false} = {}) {
  try { assertRuntime(runtime); } catch { return false; }
  return runtime.status === 'ready' && (officialWslReady(runtime) || allowTest && runtime.provider === 'test_stub');
}
export function designInput(snapshot) {
  validateCanonicalSiteSpec(snapshot);
  const draft = normalizeEditableDraft(editableDraftFromSiteSpec(snapshot));
  if (!draft.siteType || !draft.businessType || !draft.niche)
    designError('DESIGN_BRIEF_INCOMPLETE');
  boundedJson(draft, 4096);
  if (/(?:pair|agt|lease)_[A-Za-z0-9_-]{43}/.test(JSON.stringify(draft)))
    designError('DESIGN_BRIEF_REJECTED');
  return draft;
}
export function expectedPages(brief) {
  return ['catalog', 'seo-network'].includes(brief.siteType)
    ? ['home', 'catalog', 'product']
    : brief.siteType === 'multipage'
      ? ['home', 'about', 'contact']
      : ['home'];
}
function luminance(color) {
  const rgb = [1, 3, 5]
    .map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
export function contrast(a, b) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function assertProposal(value, brief) {
  boundedJson(value, 12288);
  if (!validate(value)) designError('CODEX_INVALID_OUTPUT');
  if (/(?:pair|agt|lease)_[A-Za-z0-9_-]{43}/.test(JSON.stringify(value)))
    designError('CODEX_INVALID_OUTPUT');
  const required = {
    home: ['hero', 'enquiry'],
    catalog: ['categories', 'products'],
    product: ['specifications', 'enquiry'],
    about: ['about', 'enquiry'],
    contact: ['about', 'enquiry'],
  };
  if (
    new Set(value.concepts.map((c) => c.id)).size !== 3 ||
    new Set(value.concepts.map((c) => c.layoutVariant)).size !== 3
  )
    designError('DESIGN_DUPLICATE_CONCEPT');
  for (const concept of value.concepts) {
    if (
      /(https?:|www\.|url\s*\(|javascript:|сертификат|отзыв|гаранти|доставк|наличи|рубл|price|stock|review|certificat|delivery|guarantee)/iu.test(
        concept.name + ' ' + concept.rationale,
      )
    )
      designError('DESIGN_UNSUPPORTED_COPY');
    const palette = concept.palette;
    if (
      contrast(palette.text, palette.background) < 4.5 ||
      contrast(palette.text, palette.surface) < 4.5 ||
      contrast(palette.accentText, palette.accent) < 4.5
    )
      designError('DESIGN_CONTRAST_FAILED');
    if (
      !equal(
        concept.pages.map((p) => p.id),
        expectedPages(brief),
      )
    )
      designError('DESIGN_PAGE_MISMATCH');
    for (const page of concept.pages)
      if (required[page.id].some((id) => !page.blocks.includes(id)))
        designError('DESIGN_BLOCK_MISSING');
  }
  return value;
}
export function materializeDesign(job, snapshot, workspaceId, runtime) {
  assertRuntime(runtime);
  const brief = designInput(snapshot);
  const spec = {
    jobSpecVersion: '1.4.1',
    executionProfile: 'codex_design',
    type: 'design_proposal',
    jobId: job.id,
    projectId: job.project_id,
    workspaceId,
    input: {
      revisionId: job.site_spec_revision_id,
      revision: job.input_revision,
      sha256: job.input_sha256.trim(),
      snapshot,
      brief,
      briefSha256: sha256Json(brief),
    },
    settings: DESIGN_SETTINGS,
    policy: DESIGN_POLICY,
    adapter: ADAPTER,
    runtime,
  };
  assertDesignSpec(spec);
  return { spec, sha256: sha256Json(spec) };
}
export function assertDesignSpec(spec, digest) {
  boundedJson(spec);
  if (!validateJob(spec)) designError('INVALID_DESIGN_SPEC');
  if (
    spec?.jobSpecVersion !== '1.4.1' ||
    spec?.executionProfile !== 'codex_design' ||
    spec?.type !== 'design_proposal' ||
    Object.keys(spec).sort().join() !==
      'adapter,executionProfile,input,jobId,jobSpecVersion,policy,projectId,runtime,settings,type,workspaceId' ||
    !/^job_[a-f0-9]{32}$/.test(spec.jobId) ||
    !/^[a-f0-9-]{36}$/.test(spec.projectId) ||
    !/^[a-f0-9-]{36}$/.test(spec.workspaceId) ||
    !equal(spec.settings, DESIGN_SETTINGS) ||
    !equal(spec.policy, DESIGN_POLICY) ||
    !adapterCompatible(spec.adapter)
  )
    designError('INVALID_DESIGN_SPEC');
  assertRuntime(spec.runtime);
  const input = spec.input;
  if (
    !input ||
    Object.keys(input).sort().join() !==
      'brief,briefSha256,revision,revisionId,sha256,snapshot' ||
    !/^[a-f0-9-]{36}$/.test(input.revisionId) ||
    !input.snapshot ||
    input.snapshot.projectId !== spec.projectId ||
    input.snapshot.revision !== input.revision ||
    sha256Json(input.snapshot) !== input.sha256 ||
    !equal(designInput(input.snapshot), input.brief) ||
    sha256Json(input.brief) !== input.briefSha256 ||
    (digest !== undefined &&
      (!/^[a-f0-9]{64}$/.test(digest) || sha256Json(spec) !== digest))
  )
    designError('INPUT_HASH_MISMATCH');
  return spec;
}
export function assertDesignReport(report, spec, attempt) {
  assertDesignSpec(spec);
  boundedJson(report, 16384);
  if (
    !report ||
    Object.keys(report).sort().join() !==
      'attempt,cliVersion,effort,inputSha256,jobId,jobSpecSha256,model,modelEvidence,proposal,provider,providerInvocations,reportVersion,usage' ||
    report.reportVersion !== '1.1.0' ||
    report.attempt !== attempt ||
    attempt !== 1 ||
    report.jobId !== spec.jobId ||
    report.inputSha256 !== spec.input.sha256 ||
    report.jobSpecSha256 !== sha256Json(spec) ||
    report.provider !== spec.runtime.provider ||
    report.cliVersion !== spec.runtime.cliVersion ||
    report.model !== spec.settings.model ||
    report.effort !== spec.settings.effort ||
    !equal(report.modelEvidence, modelEvidence(spec)) ||
    report.providerInvocations !== 1
  )
    designError('DESIGN_REPORT_MISMATCH');
  if (
    report.usage !== null &&
    (!report.usage ||
      Object.keys(report.usage).sort().join() !== 'inputTokens,outputTokens' ||
      ![report.usage.inputTokens, report.usage.outputTokens].every(
        (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000000,
      ))
  )
    designError('DESIGN_REPORT_MISMATCH');
  assertProposal(report.proposal, spec.input.brief);
  return report;
}

export function modelEvidence(spec) {
  return {
    requestedModel: spec.settings.model,
    resolvedModel: spec.runtime.modelSelection?.resolvedModel ?? null,
    observedModel: null,
    source: spec.runtime.modelSelection?.source ?? null,
  };
}
