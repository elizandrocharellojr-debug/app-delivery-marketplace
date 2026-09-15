// Registra o service worker nas páginas do lojista/admin, para permitir
// instalar o painel na tela inicial do celular como um app (PWA). As
// páginas do cliente usam src/push.js, que faz o mesmo registro e ainda
// ativa notificações push.
(function () {
  "use strict";

  function init() {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    navigator.serviceWorker.register("/service-worker.js").catch(function (error) {
      console.error("Não foi possível registrar o service worker:", error);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
