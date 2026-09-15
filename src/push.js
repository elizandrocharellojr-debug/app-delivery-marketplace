// Registra o service worker (necessário para o app poder ser instalado na
// tela inicial do celular como PWA) e, se o cliente estiver logado, também
// ativa as notificações push para avisar sobre o status do pedido mesmo com
// o app fechado. Só roda em páginas do cliente (não nas páginas do lojista,
// que usam src/pwa.js).
(function () {
  "use strict";

  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function registerPushNotifications(registration) {
    if (!registration || !("PushManager" in window) || !("Notification" in window)) {
      return;
    }

    var session =
      window.appDatabase && window.appDatabase.getCustomerSession
        ? window.appDatabase.getCustomerSession()
        : null;

    if (!session || !session.customerId) {
      return;
    }

    if (Notification.permission === "denied") {
      return;
    }

    Promise.resolve(registration)
      .then(function (registration) {
        return fetch("/api/push/vapid-public-key")
          .then(function (response) {
            if (!response.ok) {
              return null;
            }
            return response.json();
          })
          .then(function (keyData) {
            if (!keyData || !keyData.publicKey) {
              return null;
            }

            var ensurePermission =
              Notification.permission === "granted"
                ? Promise.resolve("granted")
                : Notification.requestPermission();

            return ensurePermission.then(function (permission) {
              if (permission !== "granted") {
                return null;
              }

              return registration.pushManager.getSubscription().then(function (existingSubscription) {
                if (existingSubscription) {
                  return existingSubscription;
                }

                return registration.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
                });
              });
            });
          });
      })
      .then(function (subscription) {
        if (!subscription) {
          return;
        }

        return fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId: session.customerId,
            subscription: subscription.toJSON ? subscription.toJSON() : subscription
          })
        });
      })
      .catch(function (error) {
        console.error("Não foi possível ativar notificações push:", error);
      });
  }

  function init() {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    navigator.serviceWorker
      .register("/service-worker.js")
      .then(function (registration) {
        registerPushNotifications(registration);
      })
      .catch(function (error) {
        console.error("Não foi possível registrar o service worker:", error);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
