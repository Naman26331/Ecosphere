// A small HTTP toolkit: pattern router, JSON/multipart body parsing, static files.
// Deliberately dependency-free -- this is the whole reason `npm install` is a no-op.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Collect the raw request body, with a hard cap so an upload can't OOM us. */
export function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Malformed JSON body'), { status: 400 });
  }
}

/**
 * Parse a multipart/form-data body.
 * Returns { fields: {name: value}, files: [{field, filename, type, data}] }.
 *
 * We split on the boundary at the Buffer level rather than converting to a
 * string first -- turning binary image bytes into UTF-8 corrupts them.
 */
export async function readMultipart(req) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) throw Object.assign(new Error('Expected multipart/form-data'), { status: 400 });

  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  const body = await readBody(req);
  const fields = {};
  const files = [];

  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.slice(start, start + 2).toString() === '--') break; // closing boundary

    const next = body.indexOf(boundary, start);
    if (next === -1) break;

    // Each part is: \r\n <headers> \r\n\r\n <payload> \r\n
    const part = body.slice(start + 2, next - 2);
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) {
      pos = next;
      continue;
    }

    const headers = part.slice(0, sep).toString('utf8');
    const data = part.slice(sep + 4);

    const nameMatch = headers.match(/name="([^"]*)"/i);
    const fileMatch = headers.match(/filename="([^"]*)"/i);
    const typeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    const field = nameMatch ? nameMatch[1] : '';

    if (fileMatch && fileMatch[1]) {
      files.push({
        field,
        filename: fileMatch[1],
        type: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data,
      });
    } else if (field) {
      fields[field] = data.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

/** Serve a file from `root`, refusing anything that escapes it via `../`. */
export function serveStatic(root, urlPath, res) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, rel);

  if (!file.startsWith(root)) {
    json(res, 403, { error: 'Forbidden' });
    return true;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return false;

  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': type.startsWith('image/') ? 'public, max-age=3600' : 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}

/**
 * Router. Patterns look like 'GET /api/goals/:id'; :params land in req.params.
 * Handlers return a value (sent as 200 JSON) or call res themselves.
 */
export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    const names = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/:([A-Za-z_]+)/g, (_, n) => {
          names.push(n);
          return '([^/]+)';
        }) +
        '$'
    );
    routes.push({ method, regex, names, handler });
  };

  const router = {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),

    async handle(req, res, pathname) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = pathname.match(r.regex);
        if (!match) continue;

        req.params = Object.fromEntries(r.names.map((n, i) => [n, match[i + 1]]));
        const result = await r.handler(req, res);
        if (result !== undefined && !res.writableEnded) json(res, 200, result);
        return true;
      }
      return false;
    },
  };
  return router;
}
