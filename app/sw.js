// Service worker de Navestigio: guarda una copia de la app para que abra aunque servir_navestigio.py no esté corriendo.
// Siempre intenta primero la versión del servidor (así llegan las actualizaciones). La evidencia nunca pasa por aquí:
// los archivos se leen dentro del navegador y no se envían a ningún servidor.
// Solo intercepta las rutas propias de Navestigio y solo guarda respuestas marcadas por servir_navestigio.py, para que otra
// aplicación que use el mismo puerto no reemplace la copia guardada.
const CACHE = "navestigio-v3";
const PAGE = new Set(["/", "/index.html", "/navestigio.html"]);
const APP = ["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const key = PAGE.has(url.pathname) ? "/" : APP.includes(url.pathname) ? url.pathname : null;
  if (!key) return; // cualquier otra ruta: ni se intercepta ni se guarda
  // Red primero, copia guardada si el servidor no responde.
  e.respondWith(fetch(req).then(r => {
    if (r.ok && r.headers.get("X-Navestigio") === "1") { const cp = r.clone(); caches.open(CACHE).then(c => c.put(key, cp)); }
    return r;
  }).catch(() => caches.match(key)));
});
