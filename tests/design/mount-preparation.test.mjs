import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  preparationPlan,
  applyPreparation,
  parseMounts,
  preservedDnsConfig,
} from '../../scripts/lab/mount-preparation.mjs';
void test('only known per-distro DNS config changes once, with security flags preserved', () => {
  const base =
    '[boot]\nsystemd=false\n\n[automount]\nenabled=false\nmountFsTab=false\n\n[interop]\nenabled=false\nappendWindowsPath=false\n\n[user]\ndefault=codexlab\n';
  const expected = base + '\n[network]\ngenerateResolvConf=false\n';
  assert.equal(preservedDnsConfig(base), expected);
  assert.equal(preservedDnsConfig(expected), expected);
  for (const unknown of [
    base.replace('enabled=false', 'enabled=true'),
    base + '\n[network]\nhostname=other\n',
    '[unknown]',
  ])
    assert.throws(() => preservedDnsConfig(unknown), {
      code: 'LAB_DNS_CONFIG_UNKNOWN',
    });
});
const clean = '80 65 8:48 / / rw - ext4 /dev/sdd rw';
const dirty =
  clean +
  '\n81 80 0:38 / /mnt/wslg rw shared:2 - tmpfs none rw\n82 81 8:48 / /mnt/wslg/distro ro shared:3 - ext4 /dev/sdd rw\n76 80 0:32 / /mnt/wsl rw shared:1 - tmpfs none rw';
const inventory = (mountinfo = dirty) => ({
  distro: 'B2B-Codex-Lab',
  uid: 0,
  os: 'ubuntu:24.04',
  namespace: 'mnt:[123]',
  initNamespace: 'mnt:[123]',
  initName: 'init(B2B-Codex-',
  busy: false,
  mountinfo,
});
function harness() {
  let value = inventory();
  const calls = [];
  const ops = {
    inventory: () => value,
    preserveDns: () => 'unchanged',
    dnsHash: () => 'unchanged',
    command: (file, args) => {
      calls.push([file, args]);
      const target = args.at(-1);
      const mounts = parseMounts(value.mountinfo);
      if (file === '/bin/mount')
        value = {
          ...value,
          mountinfo: mounts
            .map((m) =>
              m.target === target || m.target.startsWith(target + '/')
                ? m.line.replace(/ shared:\d+/g, '')
                : m.line,
            )
            .join('\n'),
        };
      else
        value = {
          ...value,
          mountinfo: mounts
            .filter((m) => m.target !== target)
            .map((m) => m.line)
            .join('\n'),
        };
    },
  };
  return { ops, calls };
}
void test('dirty lab detaches only known subtrees, child-first, retaining private parent; clean repeat is no-op', () => {
  const { ops, calls } = harness();
  assert.equal(applyPreparation(ops.inventory(), ops).status, 'LAB_PREPARED');
  assert.deepEqual(calls, [
    ['/bin/mount', ['--make-rprivate', '/mnt/wslg']],
    ['/bin/umount', ['/mnt/wslg/distro']],
    ['/bin/umount', ['/mnt/wslg']],
    ['/bin/mount', ['--make-rprivate', '/mnt/wsl']],
    ['/bin/umount', ['/mnt/wsl']],
  ]);
  const count = calls.length;
  assert.deepEqual(applyPreparation(ops.inventory(), ops).removed, []);
  assert.equal(calls.length, count);
  assert.deepEqual(preparationPlan(inventory(clean)).targets, []);
});
void test('other distro, ephemeral namespace, unknown mounts, workload and unsafe parent fail before writes', () => {
  for (const [change, code] of [
    [{ distro: 'docker-desktop' }, 'LAB_IDENTITY_MISMATCH'],
    [{ namespace: 'mnt:[456]' }, 'LAB_NAMESPACE_UNPROVEN'],
    [{ busy: true }, 'LAB_WORKLOAD_BUSY'],
    [
      {
        mountinfo: dirty + '\n99 81 1:1 / /mnt/wslg/unknown rw - tmpfs none rw',
      },
      'LAB_UNKNOWN_MOUNT',
    ],
    [
      { mountinfo: dirty.replace('/ / rw -', '/ / rw shared:9 -') },
      'LAB_PARENT_PROPAGATION_UNSAFE',
    ],
    [
      { mountinfo: dirty.replace('81 80', '81 99') },
      'LAB_PARENT_PROPAGATION_UNSAFE',
    ],
  ]) {
    assert.throws(
      () =>
        applyPreparation(
          { ...inventory(), ...change },
          { preserveDns: () => assert.fail('No writes before preflight') },
        ),
      { code },
    );
  }
});
void test('busy unmount or ineffective propagation change stops without force/lazy or success', () => {
  const { ops, calls } = harness();
  const command = ops.command;
  ops.command = (file, args) => {
    if (file === '/bin/umount')
      throw Object.assign(Error(), { code: 'LAB_UNMOUNT_BUSY_OR_FAILED' });
    command(file, args);
  };
  assert.throws(() => applyPreparation(inventory(), ops), {
    code: 'LAB_UNMOUNT_BUSY_OR_FAILED',
  });
  assert.equal(calls.length, 1);
  assert.throws(
    () =>
      applyPreparation(inventory(), { ...harness().ops, command: () => {} }),
    { code: 'LAB_PROPAGATION_CHANGE_FAILED' },
  );
});
void test('operator preparation is not an adapter bypass; cold lab guard remains active', async () => {
  const runtime = await readFile(
    new URL('../../agent/codex/wsl-runtime.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(runtime.includes('LAB_HOST_MOUNTS_PRESENT'));
  for (const file of ['adapter.mjs', 'wsl-runtime.mjs', 'wsl-bridge.mjs']) {
    const code = await readFile(
      new URL('../../agent/codex/' + file, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(code, /prepare-mounts|mount-preparation|transfer\.mjs/);
  }
});
