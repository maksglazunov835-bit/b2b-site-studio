import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import app from '../dist/server/index.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const clientDir = resolve(process.cwd(), 'dist/client');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function assetPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = resolve(join(clientDir, clean));
  return target === clientDir || target.startsWith(clientDir + sep) ? target : null;
}

async function fetchAsset(request) {
  const url = new URL(request.url);
  const target = assetPath(url.pathname === '/' ? '/index.html' : url.pathname);

  if (!target) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    await access(target);
    const info = await stat(target);

    if (!info.isFile()) {
      return new Response('Not found', { status: 404 });
    }

    const headers = new Headers({
      'cache-control': url.pathname.startsWith('/_next/static/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=300',
      'content-length': String(info.size),
      'content-type': contentTypes[extname(target).toLowerCase()] || 'application/octet-stream',
    });

    return new Response(Readable.toWeb(createReadStream(target)), { headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

async function toWebRequest(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const hostHeader = req.headers.host || `localhost:${port}`;
  const url = `${protocol}://${hostHeader}${req.url}`;
  const headers = new Headers();
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => headers.append(key, entry));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  if (method === 'GET') {
    return new Request(url, { headers, method });
  }

  return new Request(url, {
    body: Readable.toWeb(req),
    duplex: 'half',
    headers,
    method,
  });
}

function writeResponse(res, response) {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  response.headers.forEach((value, key) => res.setHeader(key, value));

  if (!response.body || res.req.method === 'HEAD') {
    res.end();
    return;
  }

  Readable.fromWeb(response.body).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const assetResponse = await fetchAsset({
      url: `http://localhost${req.url}`,
    });

    if (assetResponse.status !== 404) {
      writeResponse(res, assetResponse);
      return;
    }

    const request = await toWebRequest(req);
    const response = await app.fetch(
      request,
      { ASSETS: { fetch: fetchAsset } },
      { waitUntil: () => undefined },
    );
    writeResponse(res, response);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
});

server.listen(port, host, () => {
  console.log(`B2B Site Studio is running on http://${host}:${port}`);
});
