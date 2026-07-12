// EcoSphere Auto-Pilot -- server entry point.
//
// No framework, no dependencies. `npm install` installs nothing; `npm start`
// just works. Static files come out of public/, uploads out of data/uploads/,
// and everything under /api is handled by the router.
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from './src/db.js';
import { createRouter, serveStatic, json } from './src/lib/http.js';
import registerRoutes from './src/routes/index.js';

const root = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(root, 'public');
const UPLOADS = join(root, 'data', 'uploads');
const PORT = Number(process.env.PORT) || 3000;

migrate(); // idempotent -- safe on every boot

const router = createRouter();
registerRoutes(router);

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    // Uploaded proof photos and scanned bills.
    if (pathname.startsWith('/uploads/')) {
      if (serveStatic(UPLOADS, pathname.slice('/uploads'.length), res)) return;
      return json(res, 404, { error: 'Upload not found' });
    }

    if (pathname.startsWith('/api/')) {
      if (await router.handle(req, res, pathname)) return;
      return json(res, 404, { error: `No route for ${req.method} ${pathname}` });
    }

    // Pretty URLs: /social -> public/social.html
    if (serveStatic(PUBLIC, pathname === '/' ? '/index.html' : pathname, res)) return;
    if (!pathname.includes('.') && serveStatic(PUBLIC, `${pathname}.html`, res)) return;

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(`[${req.method} ${pathname}]`, err);
    if (!res.writableEnded) json(res, status, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  EcoSphere Auto-Pilot`);
  console.log(`  running at  http://localhost:${PORT}`);
  console.log(`  AI provider ${process.env.AI_PROVIDER ?? 'rules'} (offline)\n`);
});
