// Shared front-end runtime: API client, the app shell (rendered once, here,
// instead of hand-copied into seven files), chart primitives and toasts.

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * A 401 means the session is gone -- expired, or signed out in another tab.
 * Bounce to the login page rather than letting each caller invent its own
 * handling and leave a half-dead dashboard on screen. `next` brings the user
 * back to the page they were on once they sign in.
 */
function handleUnauthorized(res) {
  if (res.status !== 401 || location.pathname === '/login') return false;
  location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  return true;
}

export const api = {
  async get(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    if (handleUnauthorized(res)) return new Promise(() => {}); // never settles; page is navigating
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.json();
  },
  async send(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    // The login endpoint returns 401 on a bad password -- that is a normal
    // answer to show the user, not a dead session, so don't redirect on it.
    if (!path.startsWith('/api/auth/') && handleUnauthorized(res)) return new Promise(() => {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data;
  },
  post: (p, b) => api.send('POST', p, b),
  put: (p, b) => api.send('PUT', p, b),
  patch: (p, b) => api.send('PATCH', p, b),

  /** Multipart upload -- used by the OCR and photo-proof flows. */
  async upload(path, formData) {
    const res = await fetch(path, { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data;
  },
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const fmt = {
  n: (v, d = 0) =>
    v == null || Number.isNaN(v)
      ? '—'
      : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }),
  pct: (v, d = 0) => (v == null ? '—' : `${Number(v).toFixed(d)}%`),
  /** kg -> t once it stops being readable in kg. */
  co2: (kg) => (kg >= 1000 ? `${fmt.n(kg / 1000, 1)} tCO₂e` : `${fmt.n(kg, 1)} kgCO₂e`),
  date: (s) =>
    !s ? '—' : new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
  ago(s) {
    if (!s) return '—';
    const secs = (Date.now() - new Date(s.replace(' ', 'T') + (s.includes('T') ? '' : 'Z'))) / 1000;
    if (Number.isNaN(secs)) return fmt.date(s);
    const steps = [[60, 'sec'], [60, 'min'], [24, 'hr'], [7, 'day'], [4.35, 'wk'], [12, 'mo']];
    let v = Math.max(secs, 0);
    for (const [size, label] of steps) {
      if (v < size) return `${Math.floor(v)} ${label}${Math.floor(v) === 1 ? '' : 's'} ago`;
      v /= size;
    }
    return `${Math.floor(v)} yr ago`;
  },
  title: (s) => (s ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
};

/** Score -> colour. Used by every score chip in the app, so they always agree. */
export const scoreColor = (s) =>
  s >= 80 ? 'text-green-600' : s >= 65 ? 'text-secondary' : s >= 50 ? 'text-amber-600' : 'text-error';
export const scoreBg = (s) =>
  s >= 80 ? 'bg-green-600' : s >= 65 ? 'bg-secondary' : s >= 50 ? 'bg-amber-500' : 'bg-error';

export const STATUS_CHIP = {
  on_track:    'bg-secondary-container text-on-secondary-container',
  completed:   'bg-surface-container-highest text-primary',
  at_risk:     'bg-error-container text-on-error-container',
  pending:     'bg-amber-100 text-amber-800',
  open:        'bg-amber-100 text-amber-800',
  in_progress: 'bg-blue-100 text-blue-700',
  resolved:    'bg-secondary-container text-on-secondary-container',
  approved:    'bg-secondary-container text-on-secondary-container',
  rejected:    'bg-error-container text-on-error-container',
  verified:    'bg-secondary-container text-on-secondary-container',
  critical:    'bg-error-container text-on-error-container',
  high:        'bg-orange-100 text-orange-700',
  medium:      'bg-amber-100 text-amber-800',
  low:         'bg-surface-container-highest text-on-surface-variant',
};
export const chip = (status) =>
  `<span class="px-2.5 py-1 rounded-full text-label-sm font-bold whitespace-nowrap ${
    STATUS_CHIP[status] ?? 'bg-surface-container-highest text-on-surface-variant'
  }">${fmt.title(status)}</span>`;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const html = (strings, ...vals) => String.raw({ raw: strings }, ...vals);

/** Escape anything that came from the database before it goes into innerHTML. */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function render(target, markup) {
  const node = typeof target === 'string' ? $(target) : target;
  if (node) node.innerHTML = markup;
  return node;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const TOAST_STYLE = {
  success: ['check_circle', 'text-secondary', 'border-secondary'],
  error: ['error', 'text-error', 'border-error'],
  info: ['info', 'text-blue-600', 'border-blue-600'],
  award: ['military_tech', 'text-orange-500', 'border-orange-500'],
};

export function toast(message, kind = 'success', ms = 4200) {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const [icon, color, border] = TOAST_STYLE[kind] ?? TOAST_STYLE.info;
  const node = document.createElement('div');
  node.className = `toast card border-l-4 ${border} px-4 py-3 flex items-start gap-3 shadow-lg`;
  node.innerHTML = html`
    <span class="material-symbols-outlined ${color} shrink-0">${icon}</span>
    <p class="text-body-md text-on-surface flex-1 leading-snug">${esc(message)}</p>
    <button class="material-symbols-outlined text-on-surface-variant text-lg hover:text-on-surface" aria-label="Dismiss">close</button>
  `;
  const dismiss = () => {
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  };
  node.querySelector('button').onclick = dismiss;
  host.appendChild(node);
  setTimeout(dismiss, ms);
}

// ---------------------------------------------------------------------------
// UX Helpers
// ---------------------------------------------------------------------------

/**
 * Put a button into a loading state while an async action runs.
 * Restores the button automatically when the promise resolves or rejects.
 *
 * Usage:
 *   await setLoading(btn, () => api.post('/api/...'));
 */
export async function setLoading(btn, fn) {
  if (!btn) return fn();
  const original = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = html`<span class="animate-spin material-symbols-outlined text-lg">autorenew</span>`;
  try {
    return await fn();
  } finally {
    btn.disabled = wasDisabled;
    btn.innerHTML = original;
  }
}

/**
 * Show a lightweight confirmation modal before a destructive action.
 * Returns a Promise<boolean>: true if the user confirmed, false if cancelled.
 *
 * Usage:
 *   if (!await confirm('Reject this submission?', 'This cannot be undone.')) return;
 */
export function confirm(title, body = '') {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-[80] flex items-center justify-center p-4';
    el.innerHTML = html`
      <div class="absolute inset-0 bg-on-surface/40" data-cancel></div>
      <div class="relative bg-surface rounded-3xl shadow-2xl max-w-sm w-full p-6 z-10">
        <h3 class="text-title-lg font-bold text-on-surface mb-2">${esc(title)}</h3>
        ${body ? `<p class="text-body-md text-on-surface-variant mb-6">${esc(body)}</p>` : '<div class="mb-4"></div>'}
        <div class="flex gap-3 justify-end">
          <button data-cancel class="px-5 py-2.5 rounded-full text-label-lg font-semibold
                  text-on-surface-variant hover:bg-surface-container-high transition">Cancel</button>
          <button data-ok class="px-5 py-2.5 rounded-full text-label-lg font-semibold
                  bg-error text-on-error hover:opacity-90 active:scale-95 transition">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    document.body.style.overflow = 'hidden';
    const close = (val) => {
      document.body.style.overflow = '';
      el.remove();
      resolve(val);
    };
    el.querySelector('[data-ok]').onclick = () => close(true);
    el.querySelectorAll('[data-cancel]').forEach(n => n.onclick = () => close(false));
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
    });
  });
}

/**
 * Validate required fields in a form and highlight blank ones.
 * Returns true if all required inputs are filled.
 *
 * Usage:
 *   if (!validateForm(form)) return;
 */
export function validateForm(form) {
  let valid = true;
  form.querySelectorAll('[required]').forEach(input => {
    const empty = !input.value.trim();
    input.classList.toggle('ring-2', empty);
    input.classList.toggle('ring-error', empty);
    input.classList.toggle('border-error', empty);
    if (empty) {
      valid = false;
      // Remove highlight once user starts typing
      input.addEventListener('input', () => {
        input.classList.remove('ring-2', 'ring-error', 'border-error');
      }, { once: true });
    }
  });
  if (!valid) toast('Please fill in all required fields.', 'error', 3000);
  return valid;
}

// ---------------------------------------------------------------------------
// Charts -- small SVG builders, no charting library
// ---------------------------------------------------------------------------

/** Circular score gauge. `size` drives everything so it scales on mobile. */
export function gauge(score, { size = 192, stroke = 12, label = 'Out of 100' } = {}) {
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  const color = { 'text-green-600': '#16a34a', 'text-secondary': '#006c49', 'text-amber-600': '#d97706', 'text-error': '#ba1a1a' }[scoreColor(score)];

  return html`
    <div class="relative mx-auto" style="width:${size}px;height:${size}px">
      <svg class="w-full h-full -rotate-90" viewBox="0 0 ${size} ${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="transparent"
                stroke="#e5eeff" stroke-width="${stroke}"></circle>
        <circle class="gauge-ring" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="transparent"
                stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
                style="--circumference:${c};--offset:${offset}"></circle>
      </svg>
      <div class="absolute inset-0 flex flex-col items-center justify-center">
        <span class="text-display-lg ${scoreColor(score)} leading-none">${fmt.n(score, 1)}</span>
        <span class="text-label-md text-on-surface-variant mt-1">${label}</span>
      </div>
    </div>
  `;
}

/** Kick off any gauge animation once the node is in the document. */
export const drawGauges = (root = document) =>
  requestAnimationFrame(() => $$('.gauge-ring', root).forEach((g) => g.classList.add('is-drawn')));

/** Area + line chart. Scales to its container; no fixed pixel widths. */
export function areaChart(points, { height = 200, color = '#006c49', id = 'g' } = {}) {
  if (!points.length) return emptyState('No data for this period', 'show_chart');

  const W = 800;
  const H = height;
  const pad = 12;
  const values = points.map((p) => p.value);
  const max = Math.max(...values) * 1.15 || 1;
  const min = Math.min(0, ...values);

  const x = (i) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * (W - pad * 2) + pad);
  const y = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - pad * 2);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' ');
  const area = `${line} L${x(points.length - 1)},${H} L${x(0)},${H} Z`;

  return html`
    <svg class="w-full" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">
      <defs>
        <linearGradient id="grad-${id}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.22"></stop>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#grad-${id})"></path>
      <path class="spark-line" d="${line}" fill="none" stroke="${color}" stroke-width="3"
            stroke-linecap="round" stroke-linejoin="round" style="--len:${W * 1.5}"></path>
      ${points
        .map(
          (p, i) => html`<circle cx="${x(i)}" cy="${y(p.value)}" r="5" fill="${color}"
                                 stroke="#fff" stroke-width="2"><title>${esc(p.label)}: ${p.value}</title></circle>`
        )
        .join('')}
    </svg>
    <div class="flex justify-between mt-3 text-label-sm text-on-surface-variant uppercase tracking-wide">
      ${points.map((p) => `<span>${esc(p.label)}</span>`).join('')}
    </div>
  `;
}

/** Horizontal bar list -- the shape most of this data actually wants. */
export function barList(rows, { color = 'bg-secondary', unit = '' } = {}) {
  if (!rows.length) return emptyState('Nothing to show yet', 'bar_chart');
  const max = Math.max(...rows.map((r) => r.value)) || 1;

  return rows
    .map(
      (r) => html`
        <div class="flex items-center gap-3">
          <span class="w-28 sm:w-36 shrink-0 text-body-md text-on-surface truncate">${esc(r.label)}</span>
          <div class="flex-1 h-2.5 bg-surface-container rounded-full overflow-hidden">
            <div class="bar-fill h-full rounded-full ${r.color ?? color}" style="width:${(r.value / max) * 100}%"></div>
          </div>
          <span class="w-20 text-right text-body-md font-semibold text-on-surface tabular-nums">
            ${fmt.n(r.value, r.decimals ?? 1)}${unit}
          </span>
        </div>
      `
    )
    .join('');
}

export const emptyState = (message, icon = 'inbox') => html`
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <span class="material-symbols-outlined text-5xl text-outline-variant mb-3">${icon}</span>
    <p class="text-body-md text-on-surface-variant">${esc(message)}</p>
  </div>
`;

export const skeletonRows = (n = 3, h = 'h-4') =>
  Array.from({ length: n }, () => `<div class="skeleton ${h} w-full mb-3"></div>`).join('');

// ---------------------------------------------------------------------------
// App shell -- sidebar, top bar, mobile drawer, bottom nav
// ---------------------------------------------------------------------------

const NAV = [
  { id: 'dashboard',    label: 'Dashboard',    href: '/',              icon: 'dashboard',     color: 'text-secondary' },
  { id: 'environment',  label: 'Environmental', href: '/environment',  icon: 'eco',           color: 'text-green-600' },
  { id: 'social',       label: 'Social',        href: '/social',       icon: 'group',         color: 'text-blue-600' },
  { id: 'governance',   label: 'Governance',    href: '/governance',   icon: 'gavel',         color: 'text-purple-600' },
  { id: 'gamification', label: 'Gamification',  href: '/gamification', icon: 'military_tech', color: 'text-orange-500' },
  { id: 'reports',      label: 'Reports',       href: '/reports',      icon: 'assessment',    color: 'text-secondary' },
  { id: 'settings',     label: 'Settings',      href: '/settings',     icon: 'settings',      color: 'text-on-surface-variant' },
];

// Five fit across a phone; Settings lives in the drawer on mobile.
const MOBILE_NAV = NAV.filter((n) => n.id !== 'settings' && n.id !== 'reports');

/**
 * Build the chrome around the page. Call once per page with the active nav id;
 * the page then only has to own its <main> content.
 */
export function mountShell(active, { title, subtitle } = {}) {
  const shell = document.createElement('div');
  shell.innerHTML = html`
    <div id="scrim" class="fixed inset-0 bg-on-surface/40 z-40 lg:hidden"></div>

    <aside id="sidebar"
           class="fixed left-0 top-0 h-full w-[280px] bg-surface border-r border-outline-variant
                  flex flex-col py-stack-lg px-stack-md z-50 overflow-y-auto">
      <a href="/" class="flex items-center gap-3 mb-8 px-2 shrink-0">
        <div class="w-10 h-10 bg-primary-container rounded-lg flex items-center justify-center">
          <span class="material-symbols-outlined icon-filled text-on-primary-container">eco</span>
        </div>
        <div>
          <h1 class="text-headline-md font-bold text-primary leading-tight">EcoSphere</h1>
          <p class="text-label-sm text-on-surface-variant uppercase tracking-wider">Auto-Pilot</p>
        </div>
      </a>

      <nav class="flex-1 space-y-1">
        ${NAV.map(
          (n) => html`
            <a href="${n.href}"
               class="flex items-center gap-3 px-4 py-2.5 rounded-lg transition-colors ${
                 n.id === active
                   ? 'bg-surface-container-low text-secondary font-bold border-r-4 border-secondary'
                   : 'text-on-surface-variant hover:bg-surface-container-low'
               }">
              <span class="material-symbols-outlined ${n.id === active ? '' : n.color}">${n.icon}</span>
              <span class="text-body-md">${n.label}</span>
            </a>
          `
        ).join('')}
      </nav>

      <div class="pt-4 mt-4 border-t border-outline-variant shrink-0">
        <div class="flex items-center gap-3 px-2">
          <div id="nav-avatar" class="w-9 h-9 shrink-0 rounded-full bg-primary-container flex items-center
                      justify-center text-on-primary-container font-bold text-body-md">··</div>
          <div class="min-w-0 flex-1">
            <p id="nav-name" class="text-body-md font-semibold text-on-surface truncate">Loading…</p>
            <p id="nav-role" class="text-label-sm text-on-surface-variant uppercase truncate"></p>
          </div>
          <button id="logout-btn" aria-label="Sign out" title="Sign out"
                  class="p-2 shrink-0 rounded-full text-on-surface-variant hover:bg-surface-container-high
                         hover:text-error active:scale-90 transition">
            <span class="material-symbols-outlined">logout</span>
          </button>
        </div>
      </div>
    </aside>

    <header class="fixed top-0 right-0 left-0 lg:left-[280px] h-16 bg-surface/90 backdrop-blur
                   border-b border-outline-variant flex items-center justify-between
                   px-margin-mobile lg:px-margin-desktop z-30">
      <!-- flex-1 + min-w-0 is what lets the title actually truncate; without the
           flex-1 it sizes to its content and slides under the buttons on a phone. -->
      <div class="flex items-center gap-2 flex-1 min-w-0 mr-2">
        <button id="menu-btn" class="lg:hidden p-2 -ml-2 shrink-0 rounded-full hover:bg-surface-container-high active:scale-90 transition"
                aria-label="Open navigation">
          <span class="material-symbols-outlined">menu</span>
        </button>
        <div class="min-w-0">
          <h2 class="text-title-lg lg:text-headline-md text-on-surface truncate">${esc(title ?? '')}</h2>
          <p class="hidden sm:block text-body-md text-on-surface-variant truncate">${esc(subtitle ?? '')}</p>
        </div>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <button id="ask-ai-btn"
                class="flex items-center gap-2 px-3 sm:px-4 py-2 bg-secondary text-white rounded-full
                       text-label-md font-semibold shadow-sm hover:shadow-md active:scale-95 transition">
          <span class="material-symbols-outlined text-lg">auto_awesome</span>
          <span class="hidden sm:inline">Ask AI</span>
        </button>
        <button class="relative p-2 rounded-full hover:bg-surface-container-high text-on-surface-variant" aria-label="Notifications">
          <span class="material-symbols-outlined">notifications</span>
          <span id="notif-dot" class="hidden absolute top-1.5 right-1.5 w-2 h-2 bg-error rounded-full"></span>
        </button>
        <div id="top-avatar" class="w-9 h-9 rounded-full bg-primary-container flex items-center justify-center
                    text-on-primary-container font-bold text-label-md">··</div>
      </div>
    </header>

    <nav class="lg:hidden fixed bottom-0 inset-x-0 h-16 bg-surface border-t border-outline-variant
                flex items-center justify-around z-30 pb-[env(safe-area-inset-bottom)]">
      ${MOBILE_NAV.map(
        (n) => html`
          <a href="${n.href}" class="flex flex-col items-center gap-0.5 px-2 py-1 min-w-[56px] ${
            n.id === active ? 'text-secondary' : 'text-on-surface-variant'
          }" aria-label="${n.label}">
            <span class="material-symbols-outlined ${n.id === active ? 'icon-filled' : ''}">${n.icon}</span>
            <span class="text-[10px] font-semibold">${n.label.split(' ')[0]}</span>
          </a>
        `
      ).join('')}
    </nav>

    <div id="toasts"></div>
  `;
  document.body.prepend(...shell.children);

  // Drawer wiring. The sidebar is the same element at every breakpoint -- CSS
  // decides whether it's docked or sliding, so there's no duplicate markup.
  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  const setOpen = (open) => {
    sidebar.classList.toggle('is-open', open);
    scrim.classList.toggle('is-open', open);
    document.body.style.overflow = open ? 'hidden' : '';
  };
  $('#menu-btn').onclick = () => setOpen(true);
  scrim.onclick = () => setOpen(false);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && setOpen(false));
  // A nav tap inside the drawer should close it before the page swaps.
  $$('#sidebar a').forEach((a) => a.addEventListener('click', () => setOpen(false)));

  $('#ask-ai-btn').onclick = () => openChat();

  // Wire notification bell to open the dropdown panel.
  document.querySelector('[aria-label="Notifications"]').onclick = () => openNotifications();

  $('#logout-btn').onclick = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    location.href = '/login';
  };

  hydrateUser();
}

/** The signed-in user is fetched, never assumed -- the shell has no idea who
 *  you are until the server says so. */
export const initials = (name) =>
  (name ?? '?')
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

let ME = null;
export const me = () => ME;

async function hydrateUser() {
  try {
    const { user } = await api.get('/api/auth/me');
    ME = user;

    const badge = initials(user.name);
    $('#nav-avatar').textContent = badge;
    $('#top-avatar').textContent = badge;
    $('#nav-name').textContent = user.name;
    $('#nav-role').textContent = user.department
      ? `${user.role} · ${user.department}`
      : user.role;

    // Poll the notification count and light up the bell.
    refreshNotifBell();
    setInterval(refreshNotifBell, 60_000); // refresh every minute
  } catch {
    // The session died under us (expired, or signed out in another tab).
    location.href = '/login';
  }
}

/** Fetch unread count and toggle the red dot on the bell icon. */
async function refreshNotifBell() {
  try {
    const notifs = await api.get('/api/notifications?unread=true');
    const dot = $('#notif-dot');
    if (!dot) return;
    const count = Array.isArray(notifs) ? notifs.length : 0;
    dot.classList.toggle('hidden', count === 0);
    dot.title = count > 0 ? `${count} unread notification${count === 1 ? '' : 's'}` : '';
  } catch { /* silent */ }
}

/** Open the notifications panel. Wired to the bell button in the shell. */
function openNotifications() {
  if ($('#notif-panel')) { $('#notif-panel').remove(); return; }

  const panel = document.createElement('div');
  panel.id = 'notif-panel';
  panel.className = 'fixed top-16 right-4 z-[60] w-80 sm:w-96 bg-surface rounded-2xl shadow-2xl border border-outline-variant overflow-hidden';
  panel.innerHTML = html`
    <div class="flex items-center justify-between px-4 py-3 border-b border-outline-variant">
      <p class="font-semibold text-on-surface">Notifications</p>
      <button id="mark-all-read" class="text-label-sm text-secondary hover:underline">Mark all read</button>
    </div>
    <div id="notif-list" class="overflow-y-auto max-h-[60vh] divide-y divide-outline-variant">
      <div class="py-10 text-center text-on-surface-variant text-body-md">Loading…</div>
    </div>
  `;
  document.body.appendChild(panel);

  // Close on outside click
  const closeOutside = (e) => { if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('click', closeOutside); } };
  setTimeout(() => document.addEventListener('click', closeOutside), 0);

  // Mark all read
  panel.querySelector('#mark-all-read').onclick = async () => {
    await api.post('/api/notifications/read-all').catch(() => {});
    refreshNotifBell();
    panel.remove();
    toast('All notifications marked as read.', 'info');
  };

  // Load notifications
  api.get('/api/notifications').then(notifs => {
    const list = panel.querySelector('#notif-list');
    if (!notifs.length) {
      list.innerHTML = html`
        <div class="flex flex-col items-center py-10 text-center">
          <span class="material-symbols-outlined text-4xl text-outline-variant mb-2">notifications_none</span>
          <p class="text-body-md text-on-surface-variant">You're all caught up!</p>
        </div>`;
      return;
    }
    list.innerHTML = notifs.map(n => html`
      <div class="flex gap-3 px-4 py-3 ${n.read ? '' : 'bg-secondary-container/20'} hover:bg-surface-container-low transition cursor-pointer"
           data-notif-id="${n.id}" data-link="${n.link ?? ''}">
        <span class="material-symbols-outlined text-secondary shrink-0 mt-0.5">${esc(n.icon)}</span>
        <div class="flex-1 min-w-0">
          <p class="text-body-md font-semibold text-on-surface truncate">${esc(n.title)}</p>
          <p class="text-label-md text-on-surface-variant mt-0.5">${esc(n.message)}</p>
          <p class="text-label-sm text-outline mt-1">${fmt.ago(n.created_at)}</p>
        </div>
        ${n.read ? '' : '<span class="w-2 h-2 rounded-full bg-secondary shrink-0 mt-2"></span>'}
      </div>
    `).join('');

    // Click to mark read + navigate
    list.querySelectorAll('[data-notif-id]').forEach(row => {
      row.onclick = async () => {
        await api.post(`/api/notifications/${row.dataset.notifId}/read`).catch(() => {});
        refreshNotifBell();
        if (row.dataset.link) location.href = row.dataset.link;
        else panel.remove();
      };
    });
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// AI assistant -- available from every page via the header button
// ---------------------------------------------------------------------------

const SUGGESTIONS = [
  'What are the overdue compliance issues in IT?',
  'How much carbon did Manufacturing emit this quarter?',
  'Which department is doing best?',
  'Which goals are at risk?',
];

export function openChat(seed) {
  if ($('#chat-panel')) {
    if (seed) askChat(seed);
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'chat-panel';
  panel.className = 'fixed inset-0 z-[70] flex items-end sm:items-center sm:justify-center';
  panel.innerHTML = html`
    <div class="absolute inset-0 bg-on-surface/40" data-close></div>
    <div class="relative w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl
                flex flex-col max-h-[85vh] sm:max-h-[70vh]">
      <div class="flex items-center gap-3 px-5 py-4 border-b border-outline-variant shrink-0">
        <div class="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
          <span class="material-symbols-outlined text-white text-lg">auto_awesome</span>
        </div>
        <div class="flex-1">
          <p class="font-semibold text-on-surface">ESG Assistant</p>
          <p class="text-label-sm text-on-surface-variant">Answers from your live ESG data</p>
        </div>
        <button data-close class="material-symbols-outlined text-on-surface-variant hover:text-on-surface" aria-label="Close">close</button>
      </div>

      <div id="chat-log" class="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        <div class="flex gap-2.5">
          <span class="material-symbols-outlined text-secondary shrink-0">auto_awesome</span>
          <div class="bg-surface-container-low rounded-2xl rounded-tl-sm px-4 py-3 text-body-md text-on-surface">
            Ask me anything about your ESG data — emissions, compliance, goals, challenges or rankings.
          </div>
        </div>
        <div id="chat-suggestions" class="flex flex-wrap gap-2 pl-8">
          ${SUGGESTIONS.map(
            (s) => html`<button class="suggestion text-left text-label-md px-3 py-1.5 rounded-full border
                          border-outline-variant text-on-surface-variant hover:border-secondary hover:text-secondary transition">${s}</button>`
          ).join('')}
        </div>
      </div>

      <form id="chat-form" class="flex items-center gap-2 p-4 border-t border-outline-variant shrink-0">
        <input id="chat-input" autocomplete="off" placeholder="Ask about your ESG data…"
               class="flex-1 bg-surface-container-low border border-outline-variant rounded-full px-4 py-2.5
                      text-body-md focus:outline-none focus:ring-2 focus:ring-secondary/30" />
        <button class="w-11 h-11 shrink-0 rounded-full bg-secondary text-white flex items-center justify-center
                       active:scale-90 transition" aria-label="Send">
          <span class="material-symbols-outlined">send</span>
        </button>
      </form>
    </div>
  `;
  document.body.appendChild(panel);

  const close = () => {
    panel.remove();
    document.body.style.overflow = '';
  };
  $$('[data-close]', panel).forEach((n) => (n.onclick = close));
  document.body.style.overflow = 'hidden';

  $('#chat-form', panel).onsubmit = (e) => {
    e.preventDefault();
    const q = $('#chat-input', panel).value.trim();
    if (q) askChat(q);
  };
  $$('.suggestion', panel).forEach((b) => (b.onclick = () => askChat(b.textContent.trim())));

  $('#chat-input', panel).focus();
  if (seed) askChat(seed);
}

async function askChat(question) {
  const log = $('#chat-log');
  const input = $('#chat-input');
  if (!log) return;

  $('#chat-suggestions')?.remove();
  input.value = '';

  log.insertAdjacentHTML(
    'beforeend',
    html`<div class="flex justify-end">
      <div class="bg-secondary text-white rounded-2xl rounded-tr-sm px-4 py-3 text-body-md max-w-[85%]">${esc(question)}</div>
    </div>`
  );

  const pending = document.createElement('div');
  pending.className = 'flex gap-2.5';
  pending.innerHTML = html`
    <span class="material-symbols-outlined text-secondary shrink-0">auto_awesome</span>
    <div class="bg-surface-container-low rounded-2xl rounded-tl-sm px-4 py-3 w-40">
      <div class="skeleton h-3 w-full"></div>
    </div>
  `;
  log.appendChild(pending);
  log.scrollTop = log.scrollHeight;

  try {
    const res = await api.post('/api/ai/chat', { question });

    // Show the SQL it ran. An ESG answer nobody can audit is worthless.
    const table =
      res.data?.length
        ? html`
            <details class="mt-3">
              <summary class="text-label-md text-secondary cursor-pointer font-semibold">
                Show the ${res.data.length} row${res.data.length === 1 ? '' : 's'} behind this
              </summary>
              <div class="overflow-x-auto mt-2 rounded-lg border border-outline-variant">
                <table class="w-full text-label-md">
                  <thead class="bg-surface-container-high">
                    <tr>${Object.keys(res.data[0]).map((k) => `<th class="px-3 py-2 text-left font-semibold whitespace-nowrap">${esc(fmt.title(k))}</th>`).join('')}</tr>
                  </thead>
                  <tbody class="divide-y divide-outline-variant">
                    ${res.data
                      .slice(0, 8)
                      .map(
                        (row) =>
                          `<tr>${Object.values(row).map((v) => `<td class="px-3 py-2 whitespace-nowrap">${esc(v)}</td>`).join('')}</tr>`
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
            </details>
          `
        : '';

    pending.innerHTML = html`
      <span class="material-symbols-outlined text-secondary shrink-0">auto_awesome</span>
      <div class="bg-surface-container-low rounded-2xl rounded-tl-sm px-4 py-3 text-body-md text-on-surface max-w-[85%]">
        <p>${esc(res.answer)}</p>
        ${table}
      </div>
    `;
  } catch (err) {
    pending.innerHTML = html`
      <span class="material-symbols-outlined text-error shrink-0">error</span>
      <div class="bg-error-container rounded-2xl rounded-tl-sm px-4 py-3 text-body-md text-on-error-container">
        ${esc(err.message)}
      </div>
    `;
  }
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------------------
// Page bootstrap
// ---------------------------------------------------------------------------

/** Standard page start: shell, then load data, with errors surfaced not swallowed. */
export function page(active, meta, load) {
  document.addEventListener('DOMContentLoaded', async () => {
    mountShell(active, meta);
    try {
      await load();
    } catch (err) {
      console.error(err);
      toast(`Could not load this page: ${err.message}`, 'error', 8000);
    }
  });
}
