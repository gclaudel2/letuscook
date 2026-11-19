/*
 * Zéro Blabla Cuisine — Service Worker
 * - Appli : "réseau d'abord" (toujours à jour quand on est connecté), cache si hors ligne ou réseau lent
 * - Photos des recettes : mises en cache à la première vue, disponibles ensuite hors ligne
 * - Les recettes elles-mêmes sont dans IndexedDB (pas ici)
 * Changer VERSION à chaque mise en ligne d'une nouvelle version force le renouvellement du cache.
 */
const VERSION = "zbc-1.9.0"; // = APP_VERSION dans index.html
const IMAGE_CACHE = "zbc-images";
const MAX_IMAGES = 200;
const NETWORK_TIMEOUT_MS = 3500;

const SHELL = [
  "./",
  "./index.html",
  "./config.js",
  "./extracteur.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== IMAGE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(request, isNavigation) {
  const cache = await caches.open(VERSION);
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (isNavigation) return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
    return Response.error();
  }
}

async function trimCache(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_IMAGES; i++) await cache.delete(keys[i]); // les plus anciennes d'abord
}

async function cacheFirstImage(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") {
      cache.put(request, response.clone()).then(() => trimCache(cache)).catch(() => {});
    }
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // appels au relais : jamais en cache
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, request.mode === "navigate"));
    return;
  }
  if (request.destination === "image") {
    event.respondWith(cacheFirstImage(request));
  }
});
