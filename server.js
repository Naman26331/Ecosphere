// EcoSphere Auto-Pilot -- server entry point.
//
// No framework, no dependencies. `npm install` installs nothing; `npm start`
// just works. Static files come out of public/, uploads out of data/uploads/,
// and everything under /api is handled by the router.
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate, get } from './src/db.js';
import { createRouter, serveStatic, json } from './src/lib/http.js';
import { currentUser } from './src/lib/auth.js';
import registerRoutes from './src/routes/index.js';

const root = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(root, 'public');
const UPLOADS = join(root, 'data', 'uploads');
const PORT = Number(process.env.PORT) || 3000;

// Everything else -- every page, every endpoint, every uploaded bill -- requires
// a signed-in user. Listing what's open, rather than what's protected, means a
// route added later is private by default instead of accidentally public.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/api/auth/login', '/api/health', '/api/erp/webhook']);
const isPublic = (pathname) =>
  PUBLIC_PATHS.has(pathname) || pathname.startsWith('/assets/');

migrate(); // idempotent -- safe on every boot

// A hosted container starts with an empty disk: no database file, no rows. Without
// this, the app would boot "fine" and then reject every single login, which looks
// exactly like a broken password bug. Seed once, only when there is nothing there.
if (get(`SELECT COUNT(*) AS n FROM users`).n === 0) {
  console.log('  empty database detected -- seeding...');
  await import('./src/seed.js');
}

const router = createRouter();
registerRoutes(router);

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    // --- The gate ----------------------------------------------------------
    // Checked before anything is served. A signed-out visitor gets a redirect
    // if they asked for a page, and a 401 if they asked for data -- never a
    // half-rendered dashboard.
    if (!isPublic(pathname)) {
      const user = await currentUser(req);
      if (!user) {
        if (pathname.startsWith('/api/')) {
          return json(res, 401, { error: 'Not signed in' });
        }
        // Remember where they were headed, so signing in lands them there
        // rather than dumping them on the dashboard.
        const next = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
        res.writeHead(302, { Location: `/login${next}` });
        return res.end();
      }
      req.user = user; // routes read this instead of trusting a client-sent id
    }

    // A signed-in user hitting /login has no reason to see it again.
    if ((pathname === '/login' || pathname === '/login.html') && await currentUser(req)) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

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
  console.log(`  AI provider ${process.env.AI_PROVIDER ?? 'rules'} (${process.env.AI_PROVIDER === 'nvidia' ? 'online' : 'offline'})\n`);
});
