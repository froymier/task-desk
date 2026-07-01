// Task Desk service worker — kept intentionally minimal.
// It NEVER caches API calls (so data and login always stay live);
// it only lets the app be installable and load the shell when offline.
const CACHE = "taskdesk-shell-v1";

self.addEventListener("install", (e) => { self.skipWaiting(); });

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Leave the API and any non-GET requests completely alone.
  if (req.method !== "GET" || url.pathname.startsWith("/api")) return;

  // Page navigations: try the network first (always fresh), fall back to cache offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // Other GETs (fonts, icons): cache-first, then network.
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});
