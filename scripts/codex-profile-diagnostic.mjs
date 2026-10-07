// Read-only official-runtime diagnostics. Never starts a thread/turn or model call.
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  boundedProcess,
  clientEnvironment,
  execArguments,
  preflight,
} from '../agent/codex/adapter.mjs';
import { diagnosticCode } from '../agent/codex/jsonl.mjs';
const binary = process.argv[2];
if (!path.isAbsolute(binary ?? ''))
  throw new Error('Absolute official binary path required');
const directory = await mkdtemp(
  path.join(await realpath(tmpdir()), 'b2b-profile-probe-'),
);
async function readConfiguration(args, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: directory,
      env: clientEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      buffer = '',
      bytes = 0;
    const timer = setTimeout(() => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
      reject(new Error('Read-only probe timeout'));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      bytes += Buffer.byteLength(c);
      if (bytes > 131072) {
        child.kill();
        return;
      }
      stdout += c;
      buffer += c;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const r = JSON.parse(line);
          if (r.id === 0)
            child.stdin.write(
              JSON.stringify(messages[1]) +
                '\n' +
                JSON.stringify(messages[2]) +
                '\n',
            );
          if (r.id === 1) child.stdin.write(JSON.stringify(messages[3]) + '\n');
          if (r.id === 2) child.stdin.end();
        } catch {
          child.kill();
        }
      }
    });
    child.stderr.on('data', (c) => {
      bytes += Buffer.byteLength(c);
      if (bytes <= 131072) stderr += c;
      else child.kill();
    });
    child.stdin.on('error', () => {});
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Read-only probe failed'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.write(JSON.stringify(messages[0]) + '\n');
  });
}
try {
  const runtime = await preflight(binary);
  const versionHash = createHash('sha256')
    .update(await readFile(binary))
    .digest('hex');
  const help = await boundedProcess(binary, ['exec', '--help']);
  const features = await boundedProcess(binary, ['features', 'list']);
  const args = execArguments(directory, path.join(directory, 'not-used.json'));
  const disabled = args.flatMap((a, i) =>
    a === '--disable' ? [args[i + 1]] : [],
  );
  const featureRows = features.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/));
  const featureSettings = disabled.map((name) => ({
    name,
    known: featureRows.some((r) => r[0] === name),
    lifecycle:
      featureRows
        .find((r) => r[0] === name)
        ?.slice(1, -1)
        .join(' ') ?? 'unknown',
  }));
  // Schema generation is offline, without initialization or model execution.
  const schemaResult = await boundedProcess(
    binary,
    [
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
      directory,
    ],
    { maxBytes: 131072 },
  );
  if (schemaResult.code !== 0)
    throw new Error('Official schema generation failed');
  const thread = JSON.parse(
    await readFile(path.join(directory, 'v2/ThreadStartParams.json')),
  );
  const requests = JSON.parse(
    await readFile(path.join(directory, 'ClientRequest.json')),
  );
  const methods = requests.oneOf.flatMap(
    (item) => item.properties?.method?.enum ?? [],
  );
  const messages = [
    {
      id: 0,
      method: 'initialize',
      params: {
        clientInfo: { name: 'b2b_readonly_probe', version: '0.4.0' },
        capabilities: { experimentalApi: true },
      },
    },
    { method: 'initialized' },
    {
      id: 1,
      method: 'config/read',
      params: { includeLayers: false, cwd: directory },
    },
    { id: 2, method: 'configRequirements/read', params: {} },
  ];
  let applied = { status: 'unavailable' };
  try {
    const output = await readConfiguration(
      [
        'app-server',
        '--listen',
        'stdio://',
        '--strict-config',
        '-c',
        'sandbox_mode="read-only"',
        '-c',
        'approval_policy="never"',
        '-c',
        'web_search="disabled"',
        ...disabled.flatMap((name) => ['--disable', name]),
      ],
      messages,
    );
    const replies = output.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    applied = {
      status: 'no_config_reply',
      exitCode: output.code,
      diagnostic: diagnosticCode(output.stderr),
      replyIds: replies.map((r) => r.id ?? null),
      errorCodes: replies.filter((r) => r.error).map((r) => r.error.code),
    };
    const config = replies.find((r) => r.id === 1)?.result?.config;
    const requirements = replies.find((r) => r.id === 2)?.result;
    if (config && requirements)
      applied = {
        status: 'app_server_read_only_probe_only',
        sandbox: config.sandbox_mode,
        approval: config.approval_policy,
        webSearch: config.web_search,
        features: Object.fromEntries(
          disabled.map((k) => [k, config.features?.[k] ?? null]),
        ),
        managedRequirementsPresent: requirements.requirements !== null,
        // Retain only presence, never managed instructions, paths, endpoints or credentials.
        managedRequirementKeys: Object.keys(requirements.requirements ?? {}),
      };
  } catch (e) {
    applied = {
      status: 'unavailable',
      reason: e.code ?? 'NO_VALID_JSON_REPLY',
    };
  }
  console.log(
    JSON.stringify(
      {
        checkedOn: new Date().toISOString().slice(0, 10),
        runtime,
        binarySha256: versionHash,
        execFlagsPresent: [
          '--strict-config',
          '--ignore-user-config',
          '--ignore-rules',
          '--sandbox',
          '--output-schema',
        ].every((f) => help.stdout.includes(f)),
        featureSettings,
        applied,
        offlineSchema: {
          configRead: methods.includes('config/read'),
          requirementsRead: methods.includes('configRequirements/read'),
          threadToolFields: Object.keys(thread.properties).filter((k) =>
            /tool/i.test(k),
          ),
          explicitEmptyBuiltinToolsField: Object.keys(thread.properties).some(
            (k) => /^(builtinTools|allowedTools|toolChoice)$/.test(k),
          ),
        },
        effectiveExecTools: 'not_exposed_by_inspected_read_only_interfaces',
        managedRequirementsAppliedToExec:
          'unverified_without_same_exec_effective_profile_receipt',
        inferenceCalls: 0,
        status: 'blocked',
      },
      null,
      2,
    ),
  );
} finally {
  if ((await realpath(directory)) === directory)
    await rm(directory, { recursive: true });
}
