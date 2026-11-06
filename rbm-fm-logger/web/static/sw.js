"use strict";
// RBM Off-Air Vault service worker: makes the page installable and lets the app shell
// open without a connection. The app shell is fetched fresh whenever online (so updates
// show up at once) and only served from the cache when offline. Nothing under /api/ is
// ever cached: logins, recordings and downloads always go to the server.

const CACHE = "rbm-vault-shell-v16";
const SHELL = ["/", "/app.css", "/app.js", "/cassette.css", "/cassette.js", "/manifest.webmanifest",
               "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-180.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((c) => c.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then((hit) => hit || caches.match("/"))));
});
