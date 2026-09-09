import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import net from 'node:net';
import os from 'node:os';
import {
  LAB,
  LAB_DISABLED,
  labEnvironment,
  labConfig,
  labExecArgs,
  labSandboxArgs,
  labFilesystem,
  labFilesystemContext,
  completeCanary,
} from './wsl-policy.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const exists = async (name) =>
  fs.lstat(name).then(
    () => true,
    (e) => {
      if (e.code === 'ENOENT') return false;
      throw e;
    },
  );
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function inspectLab() {
  if (
    process.platform !== 'linux' ||
    os.release() !== LAB.kernel ||
    process.getuid() !== LAB.uid ||
    process.getgid() !== LAB.uid ||
    process.getgroups().some((id) => id !== LAB.uid) ||
    process.env.HOME !== LAB.home ||
    process.env.CODEX_HOME !== LAB.codexHome ||
    process.env.WSL_DISTRO_NAME !== LAB.distro
  )
    fail('LAB_SETUP_REQUIRED');
  const mounts = await fs.readFile('/proc/self/mountinfo', 'utf8');
  if (
    / (?:\/mnt\/(?:[a-z]|wsl|wslg)(?:\/[^ ]*)?|\/usr\/lib\/wsl\/[^ ]*|\/tmp\/\.X11-unix) /m.test(
      mounts,
    ) ||
    / - (?:9p|drvfs) /.test(mounts) ||
    process.env.WSL_INTEROP ||
    (await exists('/var/run/docker.sock')) ||
    (await exists('/run/docker.sock'))
  )
    fail('LAB_HOST_MOUNTS_PRESENT');
  const config = await fs.readFile('/etc/wsl.conf', 'utf8');
  const sections = Object.create(null);
  let section;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const heading = line.match(/^\[([a-z]+)\]$/);
    if (heading) {
      section = heading[1];
      if (sections[section]) fail('LAB_SETUP_REQUIRED');
      sections[section] = Object.create(null);
      continue;
    }
    const setting = line.match(/^([a-zA-Z]+)\s*=\s*([^#]+)$/);
    if (!section || !setting || Object.hasOwn(sections[section], setting[1]))
      fail('LAB_SETUP_REQUIRED');
    sections[section][setting[1]] = setting[2].trim();
  }
  if (
    sections.automount?.enabled !== 'false' ||
    sections.automount?.mountFsTab !== 'false' ||
    sections.interop?.enabled !== 'false' ||
    sections.interop?.appendWindowsPath !== 'false' ||
    sections.boot?.systemd !== 'false'
  )
    fail('LAB_SETUP_REQUIRED');
  if ((await fs.realpath('/usr/bin/python3')) !== '/usr/bin/python3.12')
    fail('LAB_SETUP_REQUIRED');
  const files = [
    [LAB.binary, LAB.hashes.codex],
    [LAB.node, LAB.hashes.node],
    [LAB.bwrap, LAB.hashes.bwrap],
    ['/usr/bin/python3.12', LAB.hashes.python],
  ];
  for (const [file, digest] of files) {
    const stat = await fs.lstat(file);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid === LAB.uid ||
      stat.mode & 0o022 ||
      hash(await fs.readFile(file)) !== digest
    )
      fail('LAB_SETUP_REQUIRED');
    for (
      let parent = file.slice(0, file.lastIndexOf('/'));
      parent;
      parent = parent.slice(0, parent.lastIndexOf('/'))
    ) {
      const s = await fs.lstat(parent);
      if (s.isSymbolicLink() || s.uid === LAB.uid || s.mode & 0o022)
        fail('LAB_SETUP_REQUIRED');
    }
  }
  // Diagnostics load managed policy normally. With no user/project config to
  // inherit, exec's --ignore-user-config has the same user layer (empty).
  for (const file of [
    `${LAB.codexHome}/config.toml`,
    `${LAB.codexHome}/.env`,
    `${LAB.home}/AGENTS.md`,
    '/home/.codex/config.toml',
    '/.codex/config.toml',
  ])
    if (await exists(file)) fail('LAB_CONFIG_CHANGED');
  await fs.mkdir(LAB.codexHome, { recursive: true, mode: 0o700 });
  await fs.mkdir(LAB.root, { recursive: true, mode: 0o700 });
  for (const directory of [LAB.home, LAB.codexHome, LAB.root]) {
    const s = await fs.lstat(directory);
    if (
      s.isSymbolicLink() ||
      s.uid !== LAB.uid ||
      s.mode & 0o022 ||
      (await fs.realpath(directory)) !== directory
    )
      fail('LAB_SETUP_REQUIRED');
  }
  return {
    hashes: LAB.hashes,
    kernel: LAB.kernel,
    uid: LAB.uid,
    hostMountsAbsent: true,
    home: LAB.home,
    codexHome: LAB.codexHome,
    modelInvocations: 0,
  };
}

// All subprocesses are fixed official CLI diagnostics or exec, never job commands.
// The subreaper owns descendants, including orphans with a new process group.
export async function supervise(
  source,
  args,
  {
    cwd,
    input = '',
    signal,
    timeoutMs = 10000,
    onData,
    onStarted,
    interactive = false,
  } = {},
) {
  let tracking = {};
  if (new RegExp(`^${LAB.root}/[a-f0-9]{32}/task$`).test(cwd)) {
    const directory = cwd.slice(0, -5),
      nonce = randomBytes(16).toString('hex');
    const startTicks = (await fs.readFile('/proc/self/stat', 'utf8'))
      .split(')')[1]
      .trim()
      .split(' ')[19];
    tracking = { nonce, receipt: `${directory}/stop-${nonce}.json` };
    await fs.writeFile(
      `${directory}/active.json`,
      JSON.stringify({ nonce, pid: process.pid, startTicks, at: Date.now() }),
      { mode: 0o600 },
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-c', source], {
      cwd,
      env: labEnvironment(),
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let last,
      stdout = '',
      stderr = '',
      bytes = 0,
      invalid = false;
    const abort = () => child.stdin.end('stop\n');
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs + 1000);
    const hard = setTimeout(() => {
      child.kill('SIGKILL');
      invalid = true;
    }, timeoutMs + 4500);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        bytes += Buffer.byteLength(line);
        if (bytes > 262144) throw Error();
        const value = JSON.parse(line);
        if (value.type === 'started')
          onStarted?.(
            (data) =>
              child.stdin.write(
                JSON.stringify({
                  type: 'input',
                  data: Buffer.from(data).toString('base64'),
                }) + '\n',
              ),
            () => child.stdin.write('{"type":"end"}\n'),
          );
        else if (value.type === 'stopped') last = value;
        else if (['stdout', 'stderr'].includes(value.type)) {
          const data = Buffer.from(value.data, 'base64');
          if (onData) onData(value.type, data);
          else if (value.type === 'stdout') stdout += data.toString();
          else stderr += data.toString();
        } else throw Error();
      } catch {
        invalid = true;
        abort();
      }
    });
    child.stderr.on('data', () => {
      invalid = true;
      abort();
    });
    child.once('error', () => {
      invalid = true;
    });
    child.once('close', (code, signalCode) => {
      clearTimeout(timer);
      clearTimeout(hard);
      lines.close();
      signal?.removeEventListener('abort', abort);
      if (invalid || code !== 0 || signalCode || last?.confirmed !== true)
        reject(
          Object.assign(Error('STOP_UNCONFIRMED'), {
            code: 'STOP_UNCONFIRMED',
          }),
        );
      else resolve({ ...last, stdout, stderr });
    });
    child.stdin.write(
      JSON.stringify({
        args,
        cwd,
        env: labEnvironment(),
        input,
        timeoutMs,
        interactive,
        ...tracking,
      }) + '\n',
    );
    if (signal?.aborted) abort();
  });
}

async function configProbe(task, signal, supervisor, filesystem = null) {
  let id = 0,
    buffer = '',
    send,
    result,
    failure,
    work = Promise.resolve();
  const pending = new Map();
  const rejectAll = () => {
    for (const p of pending.values()) p.reject(Error('LAB_CONFIG_CHANGED'));
    pending.clear();
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      send(JSON.stringify({ id, method, params }) + '\n');
    });
  const query = async () => {
    await call(
      'initialize',
      filesystem
        ? { clientName: 'b2b_wsl_fs_canary' }
        : {
            clientInfo: { name: 'b2b_wsl_preflight', version: '1.0.0' },
            capabilities: { experimentalApi: true },
          },
    );
    send('{"method":"initialized"}\n');
    if (filesystem) return await filesystem(call);
    const configRead = await call('config/read', {
      cwd: task,
      includeLayers: true,
    });
    const config = configRead.config;
    const requirements = await call('configRequirements/read');
    const account = await call('account/read', { refreshToken: false });
    const models = await call('model/list', {
      limit: 100,
      includeHidden: false,
    });
    const flagLayer = configRead.layers?.find(
      (l) => l.name?.type === 'sessionFlags',
    )?.config;
    if (
      configRead.layers?.some(
        (l) =>
          l.name?.type !== 'sessionFlags' && Object.keys(l.config ?? {}).length,
      )
    )
      fail('LAB_CONFIG_CHANGED');
    const effectiveFs = config.permissions?.[LAB.profile]?.filesystem;
    if (
      effectiveFs?.glob_scan_max_depth !== null ||
      Object.keys(effectiveFs ?? {}).length !==
        Object.keys(labFilesystem(task)).length + 1 ||
      Object.entries(labFilesystem(task)).some(
        ([key, value]) =>
          config.permissions?.[LAB.profile]?.filesystem?.[key] !== value,
      )
    )
      fail('LAB_FILESYSTEM_CONFIG_CHANGED');
    if (config.approval_policy !== 'never') fail('LAB_APPROVAL_CONFIG_CHANGED');
    if (config.web_search !== 'disabled') fail('LAB_WEB_CONFIG_CHANGED');
    // The typed config/read response omits these tools; verify the actual CLI
    // layer and refuse any inherited nonempty layer instead of guessing defaults.
    if (
      flagLayer?.tools?.update_plan?.enabled !== false ||
      flagLayer?.tools?.experimental_request_user_input?.enabled !== false
    )
      fail('LAB_TOOLS_CONFIG_CHANGED');
    if (
      config.sandbox_mode ||
      config.default_permissions !== LAB.profile ||
      config.permissions?.[LAB.profile]?.network?.enabled !== false ||
      Object.keys(config.mcp_servers ?? {}).length ||
      LAB_DISABLED.some(
        (flag) =>
          config.features?.[flag] !== false &&
          config.features?.[flag]?.enabled !== false,
      ) ||
      (requirements.requirements !== null &&
        Object.keys(requirements.requirements ?? {}).length)
    )
      fail('LAB_CONFIG_CHANGED');
    const rows = models.data?.filter(
      (row) => row.model === LAB.model && !row.hidden,
    );
    const efforts = rows?.[0]?.supportedReasoningEfforts?.map(
      (e) => e.reasoningEffort,
    );
    return {
      configSha256: hash(JSON.stringify({ config, requirements })),
      managedRequirements: 'included',
      userConfig: 'absent',
      accountType: account.account?.type ?? null,
      modelSelection:
        rows?.length === 1 &&
        efforts?.includes(LAB.effort) &&
        !models.nextCursor
          ? {
              source: 'official_model_list',
              resolvedModel: LAB.model,
              effort: LAB.effort,
              supportedReasoningEfforts: efforts,
            }
          : null,
    };
  };
  try {
    const outcome = await supervise(
      supervisor,
      [
        LAB.binary,
        filesystem ? 'exec-server' : 'app-server',
        '--listen',
        'stdio://',
        '--strict-config',
        ...labConfig(task),
      ],
      {
        cwd: task,
        signal,
        timeoutMs: 20000,
        interactive: true,
        onStarted: (write, end) => {
          send = write;
          work = query()
            .then(
              (v) => {
                result = v;
              },
              (e) => {
                failure = e;
              },
            )
            .finally(end);
        },
        onData: (stream, data) => {
          if (stream !== 'stdout') return;
          buffer += data.toString();
          let i;
          while ((i = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            const v = JSON.parse(line),
              p = pending.get(v.id);
            if (p) {
              pending.delete(v.id);
              if (v.error)
                p.reject(
                  Object.assign(Error('LAB_CONFIG_CHANGED'), {
                    code: 'LAB_CONFIG_CHANGED',
                    rpc: v.error,
                  }),
                );
              else p.resolve(v.result);
            }
          }
        },
      },
    );
    rejectAll();
    await work;
    if (failure) throw failure;
    if (outcome.code !== 0 || outcome.reason || !result)
      fail('LAB_CONFIG_CHANGED');
    return result;
  } finally {
    rejectAll();
  }
}

const connect = (host, port) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(800, () => done(false));
    s.once('error', () => done(false));
    s.once('connect', () => done(true));
  });

async function canary(task, supervisor, signal, windowsControl) {
  const nonce = randomBytes(16).toString('hex'),
    outside = `${task}/../marker`;
  const credential = `${LAB.codexHome}/b2b-synthetic-${nonce}`;
  const input = '{"synthetic":true}';
  await fs.writeFile(`${task}/input.json`, input, { flag: 'wx' });
  await fs.writeFile(outside, nonce, { flag: 'wx' });
  await fs.writeFile(credential, nonce, { flag: 'wx', mode: 0o600 });
  await fs.symlink(outside, `${task}/escape`);
  const listeners = [];
  let hits = 0;
  try {
    for (const host of ['0.0.0.0', '::1']) {
      const listener = net.createServer((s) => {
        hits++;
        s.destroy();
      });
      await new Promise((r, j) => {
        listener.once('error', j);
        listener.listen(0, host, r);
      });
      listeners.push(listener);
    }
    const privateHost = Object.values(os.networkInterfaces())
      .flat()
      .find((n) => n.family === 'IPv4' && !n.internal)?.address;
    const hosts = [
      ['127.0.0.1', listeners[0].address().port],
      ['::1', listeners[1].address().port],
      [privateHost, listeners[0].address().port],
    ];
    const route = (await fs.readFile('/proc/net/route', 'utf8'))
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find((r) => r[1] === '00000000');
    const gateway = route?.[2]
      ?.match(/../g)
      ?.reverse()
      .map((b) => parseInt(b, 16))
      .join('.');
    if (
      !gateway ||
      windowsControl?.host !== gateway ||
      !Number.isInteger(windowsControl.port) ||
      windowsControl.port < 1024 ||
      windowsControl.port > 65535
    )
      fail('LAB_NETWORK_CONTROL_FAILED');
    hosts.push([windowsControl.host, windowsControl.port]);
    const controls = [];
    for (const [host, port] of hosts)
      controls.push(!!host && (await connect(host, port)));
    if (!controls.every(Boolean)) fail('LAB_NETWORK_CONTROL_FAILED');
    hits = 0;
    const parentNet = await fs.readlink('/proc/self/ns/net');
    // CommonJS -e avoids relying on Node's ESM loader as a completion signal.
    const probe = `const fs=require('fs'),net=require('net');
      const nonce=${JSON.stringify(nonce)};
      const denied=f=>{try{f();return false}catch(e){return ['ENOENT','EACCES','EPERM','EROFS'].includes(e.code)}};
      const connect=(host,port)=>new Promise(r=>{const s=net.connect({host,port}); const done=v=>{s.destroy();r(v)};s.setTimeout(800,()=>done(true));s.once('error',()=>done(true));s.once('connect',()=>done(false))});
      (async()=>{const status=fs.readFileSync('/proc/self/status','utf8'); const routes=fs.readFileSync('/proc/net/route','utf8');
      const checks={inputRead:fs.readFileSync('input.json','utf8')===${JSON.stringify(input)},
        outputWrite:(fs.writeFileSync('output/marker',nonce),true),
        inputWriteDenied:denied(()=>fs.writeFileSync('input.json','changed')),
        siblingDenied:denied(()=>fs.readFileSync(${JSON.stringify(outside)})),
        symlinkDenied:denied(()=>fs.readFileSync('escape')),
        alternateDenied:denied(()=>fs.readFileSync('../marker')),
        credentialDenied:denied(()=>fs.readFileSync(${JSON.stringify(credential)})),
        nonRoot:process.getuid()===${LAB.uid},noCapabilities:/CapEff:\\s+0+\\n/.test(status),noNewPrivileges:/NoNewPrivs:\\s+1/.test(status),
        loopback4Denied:await connect(...${JSON.stringify(hosts[0])}),loopback6Denied:await connect(...${JSON.stringify(hosts[1])}),privateDenied:await connect(...${JSON.stringify(hosts[2])}),
        windowsHostDenied:await connect(...${JSON.stringify(hosts[3])}),
        networkNamespace:fs.readlinkSync('/proc/self/ns/net')!==${JSON.stringify(parentNet)},
        noExternalInterface:fs.readFileSync('/proc/net/dev','utf8').trim().split('\\n').slice(2).every(n=>n.trim().startsWith('lo:')),noRoute:routes.trim().split('\\n').length===1,
        interopDenied:denied(()=>fs.readFileSync('/init')),
        noHostMounts:!(/ \\/mnt\\/(?:wsl|wslg|[a-z])(?:\\/| )/.test(fs.readFileSync('/proc/self/mountinfo','utf8')))};
      const result={nonce,completed:true,checks};fs.writeFileSync('output/completed.json',JSON.stringify(result)); console.log(JSON.stringify(result));
      })().catch(e=>{console.error('PROBE_FAILURE '+e.code+' '+e.path);process.exitCode=1});`;
    const value = await supervise(
      supervisor,
      [LAB.binary, ...labSandboxArgs(task, [LAB.node, '-e', probe])],
      { cwd: task, signal },
    );
    let receipt;
    try {
      receipt = JSON.parse(value.stdout.trim());
    } catch {
      fail('LAB_PROBE_INCOMPLETE');
    }
    const persisted = JSON.parse(
      await fs.readFile(`${task}/output/completed.json`, 'utf8'),
    );
    if (
      value.code !== 0 ||
      value.reason ||
      !completeCanary(receipt, nonce) ||
      JSON.stringify(receipt) !== JSON.stringify(persisted) ||
      hits !== 0 ||
      (await fs.readFile(`${task}/input.json`, 'utf8')) !== input ||
      (await fs.readFile(outside, 'utf8')) !== nonce
    )
      fail('LAB_ISOLATION_FAILED');
    await fs.writeFile(
      `${task}/minimal.mjs`,
      `import fs from 'node:fs/promises'; import net from 'node:net'; console.log(${JSON.stringify(nonce)}); await fs.writeFile('output/esm', 'complete');`,
    );
    const esm = await supervise(
      supervisor,
      [LAB.binary, ...labSandboxArgs(task, [LAB.node, `${task}/minimal.mjs`])],
      { cwd: task, signal },
    );
    const cat = await supervise(
      supervisor,
      [
        LAB.binary,
        ...labSandboxArgs(task, ['/bin/cat', `${task}/minimal.mjs`]),
      ],
      { cwd: task, signal },
    );
    const esmCompleted =
      esm.code === 0 &&
      esm.stdout.trim() === nonce &&
      (await fs.readFile(`${task}/output/esm`, 'utf8')) === 'complete';
    if (!esmCompleted || cat.code !== 0 || !cat.stdout.includes(nonce))
      fail('LAB_PROBE_INCOMPLETE');
    // Compare socket-backed Node stdio with the real OS pipes used by the
    // supervisor, under the exact same managed policy. Exit zero is insufficient.
    const streamProbe = `const fs=require('fs');console.log('ASYNC_${nonce}');process.stdout.write('STREAM_${nonce}',()=>fs.writeSync(1,JSON.stringify({nonce:${JSON.stringify(nonce)},completed:true,socket:fs.fstatSync(1).isSocket()})+'\\n'));`;
    const socketHost = `const {spawn}=require('child_process');const p=spawn(${JSON.stringify(LAB.binary)},${JSON.stringify(labSandboxArgs(task, [LAB.node, '-e', streamProbe]))},{stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',d=>out+=d);p.stderr.resume();p.on('close',code=>console.log(JSON.stringify({code,out})));`;
    const socketRun = await supervise(
      supervisor,
      [LAB.node, '-e', socketHost],
      { cwd: task, signal },
    );
    const pipeRun = await supervise(
      supervisor,
      [LAB.binary, ...labSandboxArgs(task, [LAB.node, '-e', streamProbe])],
      { cwd: task, signal },
    );
    let socketReceipt;
    try {
      socketReceipt = JSON.parse(socketRun.stdout);
    } catch {
      fail('LAB_PROBE_INCOMPLETE');
    }
    const parseMarker = (output) => {
      const index = output.indexOf('{');
      try {
        return JSON.parse(output.slice(index));
      } catch {
        return null;
      }
    };
    const socketMarker = parseMarker(socketReceipt.out),
      pipeMarker = parseMarker(pipeRun.stdout);
    if (
      socketRun.code !== 0 ||
      socketReceipt.code !== 0 ||
      pipeRun.code !== 0 ||
      socketMarker?.nonce !== nonce ||
      !socketMarker.completed ||
      socketMarker.socket !== true ||
      pipeMarker?.nonce !== nonce ||
      !pipeMarker.completed ||
      pipeMarker.socket !== false ||
      !pipeRun.stdout.includes(`ASYNC_${nonce}`) ||
      !pipeRun.stdout.includes(`STREAM_${nonce}`)
    )
      fail('LAB_PROBE_INCOMPLETE');
    const stdioTransport = {
      socketCompleted: true,
      socketAsyncDelivered: socketReceipt.out.includes(`ASYNC_${nonce}`),
      socketStreamDelivered: socketReceipt.out.includes(`STREAM_${nonce}`),
      realPipeCompleted: true,
      realPipeAsyncDelivered: true,
    };
    const fsChecks = await configProbe(
      task,
      signal,
      supervisor,
      async (call) => {
        const sandbox = labFilesystemContext(task);
        const read = (name) =>
          call('fs/readFile', { path: `file://${name}`, sandbox });
        const write = (name) =>
          call('fs/writeFile', {
            path: `file://${name}`,
            sandbox,
            dataBase64: Buffer.from(nonce).toString('base64'),
          });
        const denied = async (operation) => {
          try {
            await operation();
            return false;
          } catch (e) {
            // Only a filesystem denial, never JSON-RPC invalid params, counts.
            return (
              e.rpc?.code === -32004 ||
              (e.rpc?.code === -32603 &&
                /os error (?:1|13|30)\)/.test(e.rpc.message))
            );
          }
        };
        const body = await read(`${task}/input.json`);
        await write(`${task}/output/fs-marker`);
        return {
          inputRead:
            Buffer.from(body.dataBase64, 'base64').toString() === input,
          outputWrite:
            (await fs.readFile(`${task}/output/fs-marker`, 'utf8')) === nonce,
          inputDenied: await denied(() => write(`${task}/input.json`)),
          siblingDenied: await denied(() => read(outside)),
          symlinkDenied: await denied(() => read(`${task}/escape`)),
          credentialDenied: await denied(() => read(credential)),
          outsideWriteDenied: await denied(() =>
            call('fs/writeFile', {
              path: `file://${outside}`,
              sandbox,
              dataBase64: Buffer.from('CHANGED').toString('base64'),
            }),
          ),
          outsideUnchanged: (await fs.readFile(outside, 'utf8')) === nonce,
        };
      },
    );
    if (
      !Object.entries(fsChecks)
        .filter(([k]) => k !== 'outsideWriteDenied')
        .every(([, v]) => v === true)
    )
      fail('LAB_FILESYSTEM_FAILED');
    return {
      ...receipt,
      positiveControls: controls,
      connections: hits,
      filesystem: fsChecks,
      esmCompleted,
      stdioTransport,
      externalNetworkEvidence:
        'different net namespace, no external interfaces, empty IPv4 routes; no external listener contacted',
    };
  } finally {
    for (const listener of listeners) listener.close();
    await fs.unlink(credential);
  }
}

export async function runLab(request, { supervisor, signal, emit }) {
  const inventory = await inspectLab();
  const receipts = `${LAB.root}/receipts`;
  await fs.mkdir(receipts, { recursive: true, mode: 0o700 });
  if ((await fs.realpath(receipts)) !== receipts) fail('LAB_SETUP_REQUIRED');
  const receiptFiles = await fs.readdir(receipts);
  if (receiptFiles.length > 256) fail('LAB_SETUP_REQUIRED');
  for (const name of receiptFiles) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) fail('LAB_SETUP_REQUIRED');
    const file = `${receipts}/${name}`,
      stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.uid !== LAB.uid ||
      stat.mode & 0o077 ||
      stat.size > 1024
    )
      fail('LAB_SETUP_REQUIRED');
    if (Date.now() - stat.mtimeMs > 60000) await fs.unlink(file);
  }
  if (request.operation === 'receipt') {
    if (!/^[a-f0-9]{32}$/.test(request.receiptId)) fail('LAB_SETUP_REQUIRED');
    const completedPath = `${receipts}/${request.receiptId}.json`;
    if (await exists(completedPath)) {
      const receipt = JSON.parse(await fs.readFile(completedPath, 'utf8'));
      if (Date.now() - receipt.at > 60000 || receipt.id !== request.receiptId)
        fail('STOP_UNCONFIRMED');
      return receipt;
    }
    const directory = `${LAB.root}/${request.receiptId}`;
    if ((await fs.realpath(directory)) !== directory) fail('STOP_UNCONFIRMED');
    const active = JSON.parse(
      await fs.readFile(`${directory}/active.json`, 'utf8'),
    );
    if (!/^[a-f0-9]{32}$/.test(active.nonce) || Date.now() - active.at > 180000)
      fail('STOP_UNCONFIRMED');
    const checkpoint = JSON.parse(
      await fs.readFile(`${directory}/stop-${active.nonce}.json`, 'utf8'),
    );
    const alive = async (record) => {
      if (
        !Number.isInteger(record.pid) ||
        record.pid < 2 ||
        !/^\d+$/.test(record.startTicks)
      )
        return true;
      try {
        const fields = (await fs.readFile(`/proc/${record.pid}/stat`, 'utf8'))
          .split(')')[1]
          .trim()
          .split(' ');
        return (
          fields[19] === record.startTicks && !['Z', 'X'].includes(fields[0])
        );
      } catch (e) {
        if (e.code === 'ENOENT') return false;
        throw e;
      }
    };
    if (
      checkpoint.stopped !== true ||
      checkpoint.nonce !== active.nonce ||
      (await alive(active)) ||
      (await alive(checkpoint))
    )
      fail('STOP_UNCONFIRMED');
    await fs.rm(directory, { recursive: true });
    return {
      id: request.receiptId,
      stopped: true,
      source: 'subreaper_checkpoint_and_owner_exit',
    };
  }
  if (
    !['preflight', 'invoke', 'lifecycle'].includes(request.operation) ||
    !/^[a-f0-9]{32}$/.test(request.runId)
  )
    fail('LAB_SETUP_REQUIRED');
  const id = request.runId,
    directory = `${LAB.root}/${id}`,
    task = `${directory}/task`;
  let stopped = true;
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.mkdir(task);
  await fs.mkdir(`${task}/output`);
  try {
    if (request.operation === 'lifecycle') {
      // Fixed synthetic descendant. No command/program in the request is accepted.
      const fixture = `const {spawn}=require('child_process');process.on('SIGTERM',()=>{});const p=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('FIXTURE_READY');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','pipe','ignore']});p.stdout.once('data',()=>console.log('FIXTURE_READY'));setInterval(()=>{},1000);`;
      if (
        !['timeout', 'abort', 'relay-eof', 'pulse-loss', 'relay-kill'].includes(
          request.scenario,
        )
      )
        fail('LAB_SETUP_REQUIRED');
      let marker = '';
      return await supervise(supervisor, [LAB.node, '-e', fixture], {
        cwd: task,
        signal,
        timeoutMs: request.scenario === 'timeout' ? 1500 : 6000,
        onData: (stream, data) => {
          if (stream === 'stdout') {
            marker += data.toString();
            if (marker === 'FIXTURE_READY\n') emit({ type: 'started' });
            else if (marker.length > 128) fail('LAB_PROBE_INCOMPLETE');
          }
        },
      });
    }
    const checks = await canary(
      task,
      supervisor,
      signal,
      request.windowsControl,
    );
    const config = await configProbe(task, signal, supervisor);
    const receipt = {
      ...inventory,
      ...config,
      canary: checks,
      status:
        config.accountType === 'chatgpt' ? 'ready' : 'CODEX_LOGIN_REQUIRED',
    };
    if (config.accountType === 'chatgpt' && !config.modelSelection)
      receipt.status = 'CODEX_MODEL_NOT_AVAILABLE';
    receipt.actionBoundary = {
      command: 'disabled_and_canary_tested',
      applyPatchFilesystem: checks.filesystem,
      clock: 'server_time_only',
      networkTools: 'disabled',
      modelInvocations: 'one',
    };
    if (request.operation === 'preflight') return receipt;
    if (receipt.status !== 'ready') fail(receipt.status);
    if (!config.modelSelection) fail('CODEX_MODEL_NOT_AVAILABLE');
    if (
      typeof request.prompt !== 'string' ||
      Buffer.byteLength(request.prompt) > 16384 ||
      !request.schema ||
      Buffer.byteLength(JSON.stringify(request.schema)) > 32768
    )
      fail('LAB_INPUT_REJECTED');
    await fs.writeFile(
      `${task}/proposal.schema.json`,
      JSON.stringify(request.schema),
      { flag: 'wx' },
    );
    await inspectLab();
    const current = await configProbe(task, signal, supervisor);
    if (
      current.configSha256 !== config.configSha256 ||
      current.accountType !== 'chatgpt'
    )
      fail('LAB_CONFIG_CHANGED');
    const result = await supervise(
      supervisor,
      [LAB.binary, ...labExecArgs(task)],
      {
        cwd: task,
        input: request.prompt,
        signal,
        timeoutMs: LAB.timeoutMs,
        onData: (stream, data) =>
          emit({ type: stream, data: data.toString('base64') }),
      },
    );
    if (result.reason)
      fail(result.reason === 'TIMEOUT' ? 'CODEX_TIMEOUT' : 'RUNNER_STOPPED');
    return {
      code: result.code,
      confirmed: result.confirmed,
      modelInvocations: 1,
      signalCode: null,
    };
  } catch (e) {
    if (e.code === 'STOP_UNCONFIRMED') stopped = false;
    throw e;
  } finally {
    // No recursive operation outside this newly created, realpath-checked run.
    if (stopped && (await fs.realpath(directory)) === directory)
      await fs.rm(directory, { recursive: true });
    await fs.writeFile(
      `${receipts}/${id}.json`,
      JSON.stringify({ id, stopped, at: Date.now() }),
      { flag: 'wx', mode: 0o600 },
    );
  }
}

export async function relay(request, supervisor) {
  const controller = new AbortController();
  let lastPulse = Date.now();
  const stop = () => controller.abort();
  process.stdout.on('error', stop);
  const watchdog = setInterval(() => {
    if (Date.now() - lastPulse > LAB.watchdogMs) stop();
  }, 200);
  const control = createInterface({ input: process.stdin });
  control.on('line', (line) => {
    if (line === 'pulse') lastPulse = Date.now();
    else stop();
  });
  control.on('close', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  try {
    emit({
      type: 'result',
      value: await runLab(request, {
        supervisor,
        signal: controller.signal,
        emit,
      }),
    });
  } catch (e) {
    emit({
      type: 'error',
      code: /^[A-Z_]+$/.test(e.code ?? '') ? e.code : 'LAB_SETUP_REQUIRED',
    });
  } finally {
    clearInterval(watchdog);
    control.close();
    process.stdin.pause();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await delay(10);
  }
}
