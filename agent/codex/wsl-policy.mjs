// Operator-owned constants. No job, brief, environment variable or CLI option
// may select a different distro, user, binary, policy, model or runtime root.
export const LAB = Object.freeze({
  distro: 'B2B-Codex-Lab',
  user: 'codexlab',
  uid: 1000,
  kernel: '6.6.114.1-microsoft-standard-WSL2',
  home: '/home/codexlab',
  codexHome: '/home/codexlab/.codex',
  root: '/home/codexlab/b2b-runs',
  profile: 'b2b-design-json',
  binary: '/opt/b2b-lab/codex-0.153.4/bin/codex',
  node: '/opt/b2b-lab/node-24.19.0/bin/node',
  bwrap: '/opt/b2b-lab/codex-0.153.4/codex-resources/bwrap',
  hashes: {
    codex: '56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da',
    node: 'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12',
    bwrap: '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c',
    python: 'c2c20b4745d447551221ec3d4e70f92c270c4609fe3df34fc52ea6dd46e92273',
  },
  version: '0.153.4',
  model: 'gpt-6-astra',
  effort: 'ultra',
  timeoutMs: 150000,
  watchdogMs: 2500,
  maxBytes: 131072,
});
export const LAB_DISABLED = [
  'shell_tool',
  'unified_exec',
  'apps',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'code_mode_host',
  'hooks',
  'image_generation',
  'in_app_browser',
  'in_app_local_automation',
  'multi_agent',
  'plugins',
  'remote_plugin',
  'shell_snapshot',
  'skill_search',
  'skill_mcp_dependency_install',
  'sleep_tool',
  'view_image',
  'workspace_dependencies',
  'tool_suggest',
  'unbounded_connection_retries',
  'request_permissions_tool',
  'token_budget',
];
export function labEnvironment() {
  return {
    HOME: LAB.home,
    CODEX_HOME: LAB.codexHome,
    PATH: '/opt/b2b-lab/node-24.19.0/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
  };
}
export function labFilesystem(task) {
  if (!new RegExp(`^${LAB.root}/[a-f0-9]{32}/task$`).test(task))
    throw Error('LAB_SETUP_REQUIRED');
  return {
    ':root': 'deny',
    ':minimal': 'read',
    '/opt/b2b-lab/codex-0.153.4': 'read',
    '/opt/b2b-lab/node-24.19.0': 'read',
    [task]: 'read',
    [`${task}/output`]: 'write',
  };
}
export function labFilesystemContext(task) {
  const entries = Object.entries(labFilesystem(task)).map(([name, access]) => ({
    access,
    path: name.startsWith(':')
      ? { type: 'special', value: { kind: name.slice(1) } }
      : { type: 'path', path: `file://${name}` },
  }));
  return {
    permissions: {
      type: 'managed',
      file_system: { type: 'restricted', entries },
      network: 'restricted',
    },
    cwd: `file://${task}`,
    workspaceRoots: [],
    userHomeDir: `file://${LAB.home}`,
    windowsSandboxLevel: 'disabled',
    useLegacyLandlock: false,
  };
}
export function labConfig(task) {
  if (!new RegExp(`^${LAB.root}/[a-f0-9]{32}/task$`).test(task))
    throw Error('LAB_SETUP_REQUIRED');
  return [
    '-c',
    `default_permissions="${LAB.profile}"`,
    '-c',
    `permissions.${LAB.profile}.filesystem={ ${Object.entries(
      labFilesystem(task),
    )
      .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
      .join(', ')} }`,
    '-c',
    `permissions.${LAB.profile}.network.enabled=false`,
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    '-c',
    'tools.update_plan.enabled=false',
    '-c',
    'tools.experimental_request_user_input.enabled=false',
    ...LAB_DISABLED.flatMap((feature) => ['--disable', feature]),
  ];
}
export function labExecArgs(task) {
  return [
    'exec',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--ephemeral',
    ...labConfig(task),
    '--model',
    LAB.model,
    '-c',
    `model_reasoning_effort="${LAB.effort}"`,
    '--color',
    'never',
    '--json',
    '--cd',
    task,
    '--output-schema',
    `${task}/proposal.schema.json`,
    '-',
  ];
}
export function labSandboxArgs(task, command) {
  return [
    'sandbox',
    '--include-managed-config',
    ...labConfig(task),
    '-P',
    LAB.profile,
    '-C',
    task,
    '--',
    ...command,
  ];
}
export const LAB_CHECKS = [
  'inputRead',
  'outputWrite',
  'inputWriteDenied',
  'siblingDenied',
  'symlinkDenied',
  'alternateDenied',
  'credentialDenied',
  'nonRoot',
  'noCapabilities',
  'noNewPrivileges',
  'loopback4Denied',
  'loopback6Denied',
  'privateDenied',
  'windowsHostDenied',
  'networkNamespace',
  'noExternalInterface',
  'noRoute',
  'interopDenied',
  'noHostMounts',
];
export function completeCanary(receipt, nonce) {
  return (
    receipt?.nonce === nonce &&
    receipt?.completed === true &&
    Object.keys(receipt.checks ?? {}).length === LAB_CHECKS.length &&
    LAB_CHECKS.every((key) => receipt.checks[key] === true)
  );
}
