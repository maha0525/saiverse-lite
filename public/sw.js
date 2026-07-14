const CACHE = "saiverse-lite-shell-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(event.request, response.clone());
        }
        return response;
      } catch (error) {
        console.warn("[SAIVerse Lite][PWA] network unavailable; cache fallback", { url: event.request.url, error });
        return (await caches.match(event.request))
          ?? (await caches.match("/index.html"))
          ?? new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain;charset=utf-8" } });
      }
    })(),
  );
});
