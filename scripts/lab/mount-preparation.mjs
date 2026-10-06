import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const roots = [
  '/tmp/.X11-unix',
  '/mnt/wslg',
  '/mnt/wsl',
  '/usr/lib/wsl/drivers',
  '/usr/lib/wsl/lib',
];
const removable = new Map([
  ['/tmp/.X11-unix', 'tmpfs'],
  ['/mnt/wsl', 'tmpfs'],
  ['/mnt/wslg', 'tmpfs'],
  ['/mnt/wslg/distro', 'ext4'],
  ['/mnt/wslg/versions.txt', 'overlay'],
  ['/mnt/wslg/doc', 'overlay'],
  ['/usr/lib/wsl/drivers', '9p'],
  ['/usr/lib/wsl/lib', 'overlay'],
]);
const retained = new Map([
  ['/', 'ext4'],
  ['/init', 'rootfs'],
  ['/dev', 'devtmpfs'],
  ['/sys', 'sysfs'],
  ['/proc', 'proc'],
  ['/dev/pts', 'devpts'],
  ['/run', 'tmpfs'],
  ['/run/lock', 'tmpfs'],
  ['/run/shm', 'tmpfs'],
  ['/dev/shm', 'tmpfs'],
  ['/run/user', 'tmpfs'],
  ['/proc/sys/fs/binfmt_misc', 'binfmt_misc'],
  ['/sys/fs/cgroup', 'cgroup2'],
  ['/usr/lib/modules/6.6.114.1-microsoft-standard-WSL2', 'overlay'],
]);
export function parseMounts(text) {
  if (text.length > 65536) fail('LAB_MOUNT_INVENTORY_INVALID');
  return text
    .trim()
    .split('\n')
    .map((line) => {
      const [left, right, extra] = line.split(' - ');
      const a = left.split(' '),
        b = right?.split(' ');
      if (extra || a.length < 6 || !b || b.length < 3 || /\\/.test(a[4]))
        fail('LAB_MOUNT_INVENTORY_INVALID');
      return {
        id: Number(a[0]),
        parent: Number(a[1]),
        device: a[2],
        root: a[3],
        target: a[4],
        propagation: a.slice(6),
        type: b[0],
        line,
      };
    });
}
export function preparationPlan(inventory) {
  if (
    inventory.distro !== 'B2B-Codex-Lab' ||
    inventory.uid !== 0 ||
    inventory.os !== 'ubuntu:24.04'
  )
    fail('LAB_IDENTITY_MISMATCH');
  if (
    !/^mnt:\[\d+\]$/.test(inventory.namespace) ||
    inventory.namespace !== inventory.initNamespace ||
    !inventory.initName.startsWith('init(B2B-Codex-')
  )
    fail('LAB_NAMESPACE_UNPROVEN');
  if (inventory.busy) fail('LAB_WORKLOAD_BUSY');
  const mounts = parseMounts(inventory.mountinfo);
  if (
    new Set(mounts.map((m) => m.target)).size !== mounts.length ||
    new Set(mounts.map((m) => m.id)).size !== mounts.length
  )
    fail('LAB_UNKNOWN_MOUNT');
  for (const m of mounts)
    if ((removable.get(m.target) ?? retained.get(m.target)) !== m.type)
      fail('LAB_UNKNOWN_MOUNT');
  const root = mounts.find((m) => m.target === '/');
  // The parent controls propagation of removal of the target itself. Do not
  // broaden preparation by making / recursive-private: require it private.
  if (!root || root.propagation.length || root.root !== '/')
    fail('LAB_PARENT_PROPAGATION_UNSAFE');
  const targets = roots.filter((p) => mounts.some((m) => m.target === p));
  for (const m of mounts.filter((m) => removable.has(m.target))) {
    const parent = mounts.find((p) => p.id === m.parent);
    if (roots.includes(m.target)) {
      if (parent !== root) fail('LAB_PARENT_PROPAGATION_UNSAFE');
    } else if (parent?.target !== '/mnt/wslg') fail('LAB_UNKNOWN_MOUNT');
    if (
      m.target === '/mnt/wslg/distro' &&
      (m.device !== root.device || m.root !== '/')
    )
      fail('LAB_UNKNOWN_MOUNT');
  }
  return {
    namespace: inventory.namespace,
    targets,
    mounts,
    retained: mounts
      .filter((m) => retained.has(m.target))
      .map((m) => m.line)
      .sort(),
  };
}
function inventory() {
  const pids = fs.readdirSync('/proc').filter((v) => /^\d+$/.test(v));
  const processes = pids.flatMap((id) => {
    try {
      const status = fs.readFileSync(`/proc/${id}/status`, 'utf8');
      return [
        {
          pid: Number(id),
          ppid: Number(status.match(/^PPid:\s+(\d+)/m)[1]),
          uid: Number(status.match(/^Uid:\s+(\d+)/m)[1]),
          name: status.match(/^Name:\s+(.+)/m)[1],
        },
      ];
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  });
  const ancestors = new Set([process.pid]);
  let current = processes.find((p) => p.pid === process.pid);
  while (current && current.ppid) {
    ancestors.add(current.ppid);
    current = processes.find((p) => p.pid === current.ppid);
  }
  const init = processes.find((p) => p.pid === 1);
  const os = fs.readFileSync('/etc/os-release', 'utf8');
  return {
    distro: process.env.WSL_DISTRO_NAME,
    uid: process.getuid(),
    os:
      os.includes('ID=ubuntu\n') && os.includes('VERSION_ID="24.04"')
        ? 'ubuntu:24.04'
        : 'unknown',
    namespace: fs.readlinkSync('/proc/self/ns/mnt'),
    initNamespace: fs.readlinkSync('/proc/1/ns/mnt'),
    initName: init?.name ?? '',
    busy: processes.some(
      (p) =>
        !ancestors.has(p.pid) ||
        p.uid !== 0 ||
        (p.pid !== process.pid &&
          p.pid !== 1 &&
          !/^(SessionLeader|Relay\(\d+\))$/.test(p.name)),
    ),
    processes,
    mountinfo: fs.readFileSync('/proc/self/mountinfo', 'utf8'),
  };
}
const command = (file, args) => {
  try {
    execFileSync(file, args, {
      timeout: 5000,
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
  } catch {
    fail(
      file === '/bin/umount'
        ? 'LAB_UNMOUNT_BUSY_OR_FAILED'
        : 'LAB_PROPAGATION_CHANGE_FAILED',
    );
  }
};
function preserveDns() {
  let info;
  try {
    info = fs.lstatSync('/etc/resolv.conf');
  } catch (error) {
    if (error.code !== 'ENOENT') fail('LAB_DNS_UNAVAILABLE');
  }
  // WSL may remove its old generated link when the per-distro option changes.
  // Only use the still-mounted live generated file, never the legacy backup.
  const source = info ? '/etc/resolv.conf' : '/mnt/wsl/resolv.conf';
  let bytes;
  try {
    bytes = fs.readFileSync(source);
  } catch {
    fail('LAB_DNS_UNAVAILABLE');
  }
  if (
    !bytes.length ||
    bytes.length > 4096 ||
    !/^nameserver\s+\S+/m.test(bytes.toString())
  )
    fail('LAB_DNS_INVALID');
  if ((info ?? fs.statSync(source)).uid !== 0) fail('LAB_DNS_INVALID');
  if (!info || info.isSymbolicLink()) {
    if (info && fs.realpathSync('/etc/resolv.conf') !== '/mnt/wsl/resolv.conf')
      fail('LAB_DNS_INVALID');
    // Preserve exactly the current generated lab resolver before its mount is
    // detached; never substitute a public resolver or reuse stale backup DNS.
    const temporary = '/etc/b2b-lab-resolv.preparing';
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 });
    fs.renameSync(temporary, '/etc/resolv.conf');
    if (fs.lstatSync('/etc/resolv.conf').isSymbolicLink())
      fail('LAB_DNS_REPLACEMENT_UNCONFIRMED');
  } else if (!info.isFile()) fail('LAB_DNS_INVALID');
  return hash(bytes);
}
export function preservedDnsConfig(current) {
  const base =
    '[boot]\nsystemd=false\n\n[automount]\nenabled=false\nmountFsTab=false\n\n[interop]\nenabled=false\nappendWindowsPath=false\n\n[user]\ndefault=codexlab\n';
  const persistent = base + '\n[network]\ngenerateResolvConf=false\n';
  if (current !== persistent && current !== base)
    fail('LAB_DNS_CONFIG_UNKNOWN');
  return persistent;
}
function preserveDnsAcrossSessions() {
  const file = '/etc/wsl.conf';
  const current = fs.readFileSync(file, 'utf8');
  const persistent = preservedDnsConfig(current);
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).uid !== 0)
    fail('LAB_DNS_CONFIG_UNKNOWN');
  if (current === persistent) return false;
  // WSL rewrites this symlink on a subsequent launch, even in the same mount
  // namespace. Keep the exact current resolver, not a guessed/public DNS.
  preserveDns();
  fs.writeFileSync('/etc/b2b-lab-wsl.preparing', persistent, {
    flag: 'wx',
    mode: 0o644,
  });
  fs.renameSync('/etc/b2b-lab-wsl.preparing', file);
  return true;
}
export function applyPreparation(initial, operations) {
  const plan = preparationPlan(initial);
  const dnsSha256 = operations.preserveDns();
  for (const target of plan.targets) {
    const fresh = preparationPlan(operations.inventory());
    if (
      fresh.namespace !== plan.namespace ||
      JSON.stringify(fresh.retained) !== JSON.stringify(plan.retained)
    )
      fail('LAB_NAMESPACE_CHANGED');
    operations.command('/bin/mount', ['--make-rprivate', target]);
    const detached = preparationPlan(operations.inventory());
    if (
      detached.mounts.some(
        (m) =>
          (m.target === target || m.target.startsWith(target + '/')) &&
          m.propagation.length,
      )
    )
      fail('LAB_PROPAGATION_CHANGE_FAILED');
    const children = detached.mounts
      .filter((m) => m.target === target || m.target.startsWith(target + '/'))
      .sort((a, b) => b.target.length - a.target.length);
    for (const child of children) {
      const now = preparationPlan(operations.inventory());
      const parent = now.mounts.find((m) => m.id === child.parent);
      if (!parent || parent.propagation.length)
        fail('LAB_PARENT_PROPAGATION_UNSAFE');
      operations.command('/bin/umount', [child.target]);
    }
  }
  const after = preparationPlan(operations.inventory());
  if (
    after.targets.length ||
    after.namespace !== plan.namespace ||
    JSON.stringify(after.retained) !== JSON.stringify(plan.retained) ||
    operations.dnsHash() !== dnsSha256
  )
    fail('LAB_PREPARATION_UNCONFIRMED');
  return {
    status: 'LAB_PREPARED',
    namespace: plan.namespace,
    removed: plan.targets,
    retainedMountsUnchanged: true,
    dnsSha256,
    modelInvocations: 0,
  };
}
if (process.argv[1] === '-' && process.argv[2]?.startsWith('--operator-')) {
  try {
    const initial = inventory();
    preparationPlan(initial);
    if (process.argv[2] === '--operator-inspect')
      console.log(JSON.stringify({ ...initial, modelInvocations: 0 }));
    else if (process.argv[2] === '--operator-prepare') {
      if (preserveDnsAcrossSessions())
        console.log(
          JSON.stringify({
            status: 'LAB_DNS_RESTART_REQUIRED',
            modelInvocations: 0,
          }),
        );
      else
        console.log(
          JSON.stringify(
            applyPreparation(initial, {
              inventory,
              preserveDns,
              command,
              dnsHash: () => hash(fs.readFileSync('/etc/resolv.conf')),
            }),
          ),
        );
    } else fail('LAB_PREPARATION_OPTIONS');
  } catch (error) {
    console.log(
      JSON.stringify({
        status: /^LAB_[A-Z_]+$/.test(error.code)
          ? error.code
          : 'LAB_PREPARATION_FAILED',
        modelInvocations: 0,
      }),
    );
    process.exitCode = 1;
  }
}
