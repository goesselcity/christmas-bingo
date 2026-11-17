// Revision 4: versioned shell. No API responses or local photos are cached here.
const CACHE = 'goessel-bingo-local-first-v4-20261117-' + self.registration.scope;
const SHELL = ['index.html', 'app.js'].map(p => new URL(p, self.registration.scope).href);
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))));
self.addEventListener('activate', e => e.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('goessel-bingo-local-first-') && k.endsWith(self.registration.scope) && k !== CACHE).map(k => caches.delete(k)))), self.clients.claim()])));
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET')
        return;
    const u = new URL(e.request.url), scope = new URL(self.registration.scope);
    if (u.origin !== scope.origin)
        return;
    const nav = e.request.mode === 'navigate' && (u.pathname === scope.pathname || u.pathname === new URL('index.html', scope).pathname), asset = SHELL.includes(u.href);
    if (!nav && !asset)
        return;
    const key = nav ? SHELL[0] : u.href;
    e.respondWith(fetch(new Request(e.request, { cache: 'no-cache' })).then(r => {
        if (r.ok) {
            const copy = r.clone();
            e.waitUntil(caches.open(CACHE).then(c => c.put(key, copy)));
        }
        return r;
    }).catch(() => caches.open(CACHE).then(c => c.match(key)).then(r => r || Response.error())));
});
