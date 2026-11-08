// Service worker de l'appli : fonctionne hors ligne et garde le moteur Firebase en mémoire.
const CACHE = "arbre-v4";
const FICHIERS = ["./", "index.html", "app.js", "synchro.js", "manifest.json", "icone-192.png", "icone-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(FICHIERS.map(f => c.add(f).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(noms => Promise.all(noms.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const memeOrigine = url.origin === self.location.origin;
  const moteurFirebase = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (!memeOrigine && !moteurFirebase) return;   // connexion, base de données… : réseau direct

  if (moteurFirebase) {
    // fichiers à version fixe : cache d'abord
    e.respondWith(
      caches.match(req).then(r => r || fetch(req).then(res => {
        if (res.ok) { const c = res.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); }
        return res;
      }))
    );
    return;
  }

  // fichiers de l'appli : réseau d'abord (pour avoir toujours la dernière version), sinon cache
  e.respondWith((async () => {
    try {
      const res = await Promise.race([
        fetch(req, { cache: "no-cache" }),
        new Promise((_, rejet) => setTimeout(() => rejet(new Error("lent")), 4000))
      ]);
      if (res && res.ok) { const c = res.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); }
      return res;
    } catch (err) {
      const r = await caches.match(req, { ignoreSearch: true });
      if (r) return r;
      if (req.mode === "navigate") {
        const accueil = (await caches.match("index.html")) || (await caches.match("./"));
        if (accueil) return accueil;
      }
      throw err;
    }
  })());
});
