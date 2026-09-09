// Fixed synthetic probe, copied to an owned task area; no model or real secrets.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { userInfo } from 'node:os';
const [outside, port] = process.argv.slice(2);
const denied = async (action) => {
  try {
    await action();
    return false;
  } catch (e) {
    return ['EACCES', 'EPERM'].includes(e.code);
  }
};
const connect = (host) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    const finish = (blocked) => {
      socket.destroy();
      resolve(blocked);
    };
    socket.setTimeout(700, () => finish(true));
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
  });
const result = {
  sandboxOfflineUser:
    userInfo().username.toLowerCase() === 'codexsandboxoffline',
  inputRead: (await readFile('input.json', 'utf8')) === '{"synthetic":true}',
  outputWrite: await writeFile('output/probe.txt', 'synthetic').then(
    () => true,
    () => false,
  ),
  inputWriteDenied: await denied(() => writeFile('input.json', 'changed')),
  siblingReadDenied: await denied(() =>
    readFile(path.join(outside, 'marker.txt')),
  ),
  siblingWriteDenied: await denied(() =>
    writeFile(path.join(outside, 'marker.txt'), 'changed'),
  ),
  junctionReadDenied: await denied(() => readFile('escape/marker.txt')),
  alternateReadDenied: await denied(() =>
    readFile(path.join(outside, '.', 'marker.txt')),
  ),
  loopbackBlocked: await connect('127.0.0.1'),
  ipv6Blocked: await connect('::1'),
  inheritedSecretAbsent: ![
    'DATABASE_URL',
    'TEST_DATABASE_URL',
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
    'B2B_CANARY_SECRET',
  ].some((key) => process.env[key]),
};
console.log(JSON.stringify(result));
// A completed diagnostic is transport-successful even when its access assertions fail.
// The parent classifies the boolean matrix and fails the isolation gate.
