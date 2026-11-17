// Public app files only. No API responses, contact information or local photos are cached here.
// Activate after old Bingo tabs close; never force-reload an in-progress submission.
const CACHE = 'goessel-bingo-local-first-controls-2026-11-17-1-' + self.registration.scope;
const SHELL = ['index.html', 'app.js', 'submitted-player-fix.js'].map(p => new URL(p, self.registration.scope).href);
self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(url => new Request(url, {cache:'reload'})))));
});
self.addEventListener('activate', event => {
    event.waitUntil(Promise.all([
        caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('goessel-bingo-local-first-') && key.endsWith(self.registration.scope) && key !== CACHE).map(key => caches.delete(key)))),
        self.clients.claim()
    ]));
});
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url), scope = new URL(self.registration.scope);
    if (url.origin !== scope.origin) return;
    const navigation = event.request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === new URL('index.html', scope).pathname);
    const asset = SHELL.includes(url.href);
    if (!navigation && !asset) return;
    const key = navigation ? SHELL[0] : url.href;
    event.respondWith(fetch(new Request(event.request, {cache:'no-cache'})).then(response => {
        if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then(cache => cache.put(key, copy)));
        }
        return response;
    }).catch(() => caches.open(CACHE).then(cache => cache.match(key)).then(response => response || Response.error())));
});
