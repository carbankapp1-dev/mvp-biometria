/* Service worker do painel (PWA)
 *
 * Objetivo: o app instalar, abrir rápido e guardar as bibliotecas e os modelos de
 * reconhecimento facial (cerca de 12 MB) depois da primeira vez.
 * Não torna o painel utilizável offline: o login e os dados dependem do Supabase.
 *
 * Regras de segurança:
 *  - Supabase e qualquer outra origem (exceto o CDN das bibliotecas) NÃO passam pelo cache.
 *  - selfie.html (página do cliente, com o token na URL) NUNCA é guardada.
 *  - Arquivos do próprio site: rede primeiro, sempre revalidando, para que uma
 *    atualização publicada no GitHub apareça logo. O cache só serve se a rede falhar.
 *
 * Ao mudar qualquer arquivo da lista SHELL, aumente a VERSAO.
 */
const VERSAO = "v1";
const CACHE_SITE = `biometria-site-${VERSAO}`;
const CACHE_CDN = `biometria-cdn-${VERSAO}`;

const SHELL = [
  "./",
  "index.html",
  "teste.html",
  "style.css",
  "config.js",
  "core.js",
  "admin.js",
  "app.js",
  "pwa.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_SITE);
      // Um arquivo ausente (ex.: config.js) não pode impedir a instalação
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const nomes = await caches.keys();
      await Promise.all(
        nomes
          .filter((n) => n !== CACHE_SITE && n !== CACHE_CDN)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

async function redePrimeiro(req) {
  try {
    const res = await fetch(req, { cache: "no-cache" }); // revalida com o servidor
    if (res.ok) {
      const cache = await caches.open(CACHE_SITE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (erro) {
    const guardado = await caches.match(req);
    if (guardado) return guardado;
    if (req.mode === "navigate") {
      const inicio = await caches.match("index.html");
      if (inicio) return inicio;
    }
    throw erro;
  }
}

async function cachePrimeiro(req) {
  const cache = await caches.open(CACHE_CDN);
  const guardado = await cache.match(req);
  if (guardado) return guardado;
  const res = await fetch(req);
  // As versões no CDN estão fixadas, então o conteúdo não muda: pode guardar
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith("/selfie.html")) return; // página do cliente: sempre direto da rede
    event.respondWith(redePrimeiro(req));
  } else if (url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(cachePrimeiro(req));
  }
  // Qualquer outra origem (Supabase etc.): não intercepta
});
