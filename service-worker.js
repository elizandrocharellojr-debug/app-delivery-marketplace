// Service Worker do Alloo.
// Responsável por: (1) permitir instalar o app na tela inicial do celular
// (PWA), guardando uma copia básica das telas/estilos para abrir mais rápido
// e funcionar minimamente sem internet; e (2) receber notificações push
// (mesmo com o app fechado ou em segundo plano) e abrir a tela correta
// quando o cliente toca na notificação.

var CACHE_NAME = "alloo-shell-v3";
var CORE_ASSETS = [
  "/manifest.json",
  "/manifest-lojista.json",
  "/styles.css",
  "/favicon.ico",
  "/assets/icon.svg",
  "/assets/logo-wordmark.png",
  "/assets/icon-192.png",
  "/assets/icon-512.png",
  "/assets/apple-touch-icon.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(CORE_ASSETS);
      })
      .catch(function () {
        // Se algum arquivo não carregar durante a instalacao, não trava o
        // service worker por causa disso.
      })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (cacheNames) {
        return Promise.all(
          cacheNames
            .filter(function (name) {
              return name !== CACHE_NAME;
            })
            .map(function (name) {
              return caches.delete(name);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

// Recebe a notificação push enviada pelo servidor (status de pedido, ou uma
// mensagem de marketing enviada pelo admin) e efetivamente exibe ela na
// tela do cliente - sem isso, a inscrição funciona mas nada aparece.
self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { title: "Alloo", body: event.data ? event.data.text() : "" };
  }

  var title = data.title || "Alloo";
  var options = {
    body: data.body || "",
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    data: { url: data.url || "/home.html" }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Quando o cliente toca na notificação, abre (ou foca, se já estiver aberta)
// a tela correspondente em vez de deixar a notificação só sumir sem ação.
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || "/home.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i += 1) {
        var client = clientList[i];
        if (client.url.indexOf(targetUrl) !== -1 && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// Só aplicamos cache/offline para os arquivos "de casca" do app (estilos,
// ícones, manifestos) listados em CORE_ASSETS. Chamadas de API (pedidos,
// login, pagamento) nunca passam por aqui, pra nunca mostrar informação
// desatualizada - sempre vão direto pra rede.
self.addEventListener("fetch", function (event) {
  var request = event.request;

  if (request.method !== "GET") {
    return;
  }

  var url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf("/api/") === 0) {
    return;
  }

  if (CORE_ASSETS.indexOf(url.pathname) === -1) {
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      var networkFetch = fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            var responseClone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(function () {
          return cached;
        });

      return cached || networkFetch;
    })
  );
});