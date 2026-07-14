/* =============================================================================
 *  sw.js — RayCastle service worker (network-first).
 *
 *  Strategy: always try the network first so an updated build shows up
 *  immediately during development, cache each successful same-origin response,
 *  and fall back to the cache (and finally to index.html) when offline.
 *
 *  Bump CACHE to invalidate the old shell on the next activate.
 * ===========================================================================*/
const CACHE = "raycastle-v1";

const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./engine.js",
  "./weapon.js",
  "./app.js",
  "./manifest.json",
  "./icons/android-chrome-192x192.png",
  "./icons/android-chrome-512x512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-16x16.png",
  "./icons/favicon-32x32.png",
  "./icons/favicon.ico"
];

// Pre-cache the shell, then take over immediately.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// Drop any old caches, then start controlling open pages.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Network-first with a cache fallback.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;   // leave non-GET requests alone

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Cache a copy of successful, same-origin responses for offline use.
        if (res && res.ok && new URL(req.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        // Offline: serve the cached copy, or fall back to the app shell.
        caches.match(req).then((hit) => hit || caches.match("./index.html"))
      )
  );
});
