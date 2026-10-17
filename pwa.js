// Registra o service worker (necessário para instalar o site como aplicativo)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => {
      console.warn("Service worker não registrado:", e);
    });
  });
}
