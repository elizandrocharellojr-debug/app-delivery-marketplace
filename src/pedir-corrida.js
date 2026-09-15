(function pedirCorridaPage() {
  "use strict";

  if (!window.appDatabase.getCustomerSession()) {
    window.location.href = "./home.html";
    return;
  }

  var MORRETES_CENTER = [-25.4784, -48.8335];
  var SEARCH_DEBOUNCE_MS = 450;
  var customerSession = window.appDatabase.getCustomerSession();
  var profile = window.appDatabase.getProfile();

  var requestScreenEl = document.getElementById("ride-request-screen");
  var trackingScreenEl = document.getElementById("ride-tracking-screen");
  var pickupHintEl = document.getElementById("ride-pickup-hint");
  var pickupLabelInputEl = document.getElementById("ride-pickup-label-input");
  var pickupSuggestionsEl = document.getElementById("ride-pickup-suggestions");
  var destinationInputEl = document.getElementById("ride-destination-input");
  var destinationSuggestionsEl = document.getElementById("ride-destination-suggestions");
  var confirmationMapEl = document.getElementById("ride-confirmation-map");
  var fareEstimateHintEl = document.getElementById("ride-fare-estimate-hint");
  var nameInputEl = document.getElementById("ride-name-input");
  var phoneInputEl = document.getElementById("ride-phone-input");
  var notesInputEl = document.getElementById("ride-notes-input");
  var paymentMethodSelectEl = document.getElementById("ride-payment-method");
  var submitButtonEl = document.getElementById("ride-request-submit-button");
  var requestMessageEl = document.getElementById("ride-request-message");

  var ridePaymentModalOverlayEl = document.getElementById("ride-payment-modal-overlay");
  var ridePaymentModalContentEl = document.getElementById("ride-payment-modal-content");
  var ridePaymentModalCloseButtonEl = document.getElementById("ride-payment-modal-close-button");

  var statusPillEl = document.getElementById("ride-status-pill");
  var trackingDetailsEl = document.getElementById("ride-tracking-details");
  var cancelButtonEl = document.getElementById("ride-cancel-button");
  var trackingMessageEl = document.getElementById("ride-tracking-message");

  // Coordenadas de partida/destino - não vêm mais de marcar num mapa, e sim
  // da localização automática (partida) e da busca de endereço com
  // sugestões (destino), igual ao "pra onde você vai?" da Uber.
  var pickupCoords = null;
  var destinationCoords = null;

  var confirmationMap = null;
  var confirmationPickupMarker = null;
  var confirmationDestinationMarker = null;

  var trackingMap = null;
  var trackingPickupMarker = null;
  var trackingDriverMarker = null;
  var pollTimer = null;
  var socketHandle = null;

  var mercadoPagoPublicKey = null;
  var mercadoPagoInstance = null;
  var ridePaymentPollTimer = null;

  nameInputEl.value = profile.name || customerSession.customerName || "";
  phoneInputEl.value = profile.phone || "";

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  function debounce(fn, delay) {
    var timer = null;
    return function debounced() {
      var context = this;
      var args = arguments;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        fn.apply(context, args);
      }, delay);
    };
  }

  // Busca endereços/lugares (autocomplete) - o servidor já junta os
  // resultados locais (cidades atendidas) com o Nominatim (OpenStreetMap).
  function searchPlaces(query, callback) {
    var trimmed = (query || "").trim();
    if (trimmed.length < 3) {
      callback([]);
      return;
    }
    fetch("/api/geocode/search?q=" + encodeURIComponent(trimmed))
      .then(function (response) {
        return response.json();
      })
      .then(function (body) {
        callback((body && body.results) || []);
      })
      .catch(function () {
        callback([]);
      });
  }

  function hideSuggestions(containerEl) {
    containerEl.hidden = true;
    containerEl.innerHTML = "";
  }

  function renderSuggestions(containerEl, results, onPick) {
    if (!results.length) {
      hideSuggestions(containerEl);
      return;
    }

    containerEl.innerHTML = results
      .map(function (place, index) {
        return (
          '<button type="button" class="ride-suggestion-item" data-index="' +
          index +
          '"><i class="fas fa-location-dot"></i><span>' +
          escapeHtml(place.label) +
          "</span></button>"
        );
      })
      .join("");
    containerEl.hidden = false;

    Array.prototype.forEach.call(containerEl.querySelectorAll(".ride-suggestion-item"), function (buttonEl) {
      // "mousedown" (em vez de "click") pra selecionar antes do input perder o
      // foco - senão o blur esconderia a lista antes do clique ser processado.
      buttonEl.addEventListener("mousedown", function (event) {
        event.preventDefault();
        var index = Number(buttonEl.getAttribute("data-index"));
        onPick(results[index]);
        hideSuggestions(containerEl);
      });
    });
  }

  // Fecha as listas de sugestão se o cliente tocar fora delas.
  document.addEventListener("click", function (event) {
    if (!pickupSuggestionsEl.contains(event.target) && event.target !== pickupLabelInputEl) {
      hideSuggestions(pickupSuggestionsEl);
    }
    if (!destinationSuggestionsEl.contains(event.target) && event.target !== destinationInputEl) {
      hideSuggestions(destinationSuggestionsEl);
    }
  });

  var debouncedPickupSearch = debounce(function () {
    searchPlaces(pickupLabelInputEl.value, function (results) {
      renderSuggestions(pickupSuggestionsEl, results, function (place) {
        pickupLabelInputEl.value = place.label;
        pickupCoords = { lat: place.lat, lng: place.lng };
        pickupHintEl.textContent = "Local de partida definido pelo endereço digitado.";
        updateFareEstimateIfReady();
      });
    });
  }, SEARCH_DEBOUNCE_MS);

  pickupLabelInputEl.addEventListener("input", debouncedPickupSearch);

  var debouncedDestinationSearch = debounce(function () {
    searchPlaces(destinationInputEl.value, function (results) {
      renderSuggestions(destinationSuggestionsEl, results, function (place) {
        destinationInputEl.value = place.label;
        destinationCoords = { lat: place.lat, lng: place.lng };
        updateFareEstimateIfReady();
      });
    });
  }, SEARCH_DEBOUNCE_MS);

  destinationInputEl.addEventListener("input", function () {
    // Digitar de novo invalida a seleção anterior - só volta a valer quando
    // o cliente escolher uma sugestão da lista, do jeito que a Uber faz.
    destinationCoords = null;
    fareEstimateHintEl.hidden = true;
    confirmationMapEl.hidden = true;
    debouncedDestinationSearch();
  });

  // Local de partida: detectado automaticamente pelo GPS do aparelho, sem
  // precisar marcar nada num mapa (evita alguém marcar um ponto errado e
  // atrapalhar o taxista na hora de achar o cliente). Se a localização
  // falhar, o cliente ainda pode digitar o endereço e escolher uma
  // sugestão da lista.
  function initPickupLocation() {
    if (!navigator.geolocation) {
      pickupHintEl.textContent =
        "Seu aparelho não permite localização automática. Digite seu endereço abaixo e escolha uma sugestão.";
      return;
    }

    pickupHintEl.textContent = "Localizando você...";

    navigator.geolocation.getCurrentPosition(
      function (position) {
        pickupCoords = { lat: position.coords.latitude, lng: position.coords.longitude };
        pickupHintEl.textContent = "Local de partida encontrado.";
        updateFareEstimateIfReady();

        fetch("/api/geocode/reverse?lat=" + pickupCoords.lat + "&lng=" + pickupCoords.lng)
          .then(function (response) {
            return response.json();
          })
          .then(function (body) {
            if (body && body.label && !pickupLabelInputEl.value.trim()) {
              pickupLabelInputEl.value = body.label;
            }
          })
          .catch(function () {});
      },
      function () {
        pickupHintEl.textContent =
          "Não conseguimos localizar você automaticamente. Digite seu endereço abaixo e escolha uma sugestão.";
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // Mapa só de visualização, sem toque nem arraste - aparece depois que
  // partida e destino já estão definidos, só pra o cliente conferir os
  // dois pontos antes de confirmar o pedido.
  function showConfirmationMap() {
    if (!pickupCoords || !destinationCoords) {
      confirmationMapEl.hidden = true;
      return;
    }

    confirmationMapEl.hidden = false;

    if (!confirmationMap) {
      confirmationMap = window.L.map("ride-confirmation-map", {
        dragging: false,
        touchZoom: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        zoomControl: false,
        tap: false
      });
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap",
        maxZoom: 19
      }).addTo(confirmationMap);
    }

    var pickupLatLng = [pickupCoords.lat, pickupCoords.lng];
    var destinationLatLng = [destinationCoords.lat, destinationCoords.lng];

    if (!confirmationPickupMarker) {
      confirmationPickupMarker = window.L.marker(pickupLatLng, { title: "Local de partida" }).addTo(confirmationMap);
    } else {
      confirmationPickupMarker.setLatLng(pickupLatLng);
    }

    if (!confirmationDestinationMarker) {
      confirmationDestinationMarker = window.L.marker(destinationLatLng, { title: "Destino" }).addTo(confirmationMap);
    } else {
      confirmationDestinationMarker.setLatLng(destinationLatLng);
    }

    // O mapa fica "hidden" (tamanho 0) até este momento - precisa recalcular
    // o tamanho depois de aparecer, senão o Leaflet renderiza tudo cortado.
    window.setTimeout(function () {
      confirmationMap.invalidateSize();
      confirmationMap.fitBounds(window.L.latLngBounds([pickupLatLng, destinationLatLng]), { padding: [30, 30] });
    }, 30);
  }

  // Mostra pro cliente, antes mesmo de confirmar o pedido, o valor fechado
  // da corrida - igual a Uber mostra antes de você chamar o carro.
  function updateFareEstimateIfReady() {
    if (!pickupCoords || !destinationCoords) {
      fareEstimateHintEl.hidden = true;
      confirmationMapEl.hidden = true;
      return;
    }

    showConfirmationMap();

    fareEstimateHintEl.hidden = false;
    fareEstimateHintEl.textContent = "Calculando o valor da corrida...";

    fetch("/api/rides/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pickupLat: pickupCoords.lat,
        pickupLng: pickupCoords.lng,
        destinationLat: destinationCoords.lat,
        destinationLng: destinationCoords.lng
      })
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          fareEstimateHintEl.textContent = "Não foi possível calcular o valor agora.";
          return;
        }
        fareEstimateHintEl.innerHTML =
          "Valor da corrida: <strong>" +
          formatMoney(result.body.suggestedPrice) +
          "</strong> · " +
          result.body.distanceKm +
          " km";
      })
      .catch(function () {
        fareEstimateHintEl.textContent = "Não foi possível calcular o valor agora.";
      });
  }

  // -----------------------------------------------------------------------
  // Pagamento da corrida (Pix / cartão) - mesma mecânica já usada no
  // checkout das lojas (src/cart.js), só que cobrando o valor fechado da
  // corrida em vez do total do carrinho.
  // -----------------------------------------------------------------------

  function openRidePaymentModal(html) {
    ridePaymentModalContentEl.innerHTML = html;
    ridePaymentModalOverlayEl.hidden = false;
  }

  function stopRidePaymentPolling() {
    if (ridePaymentPollTimer) {
      window.clearInterval(ridePaymentPollTimer);
      ridePaymentPollTimer = null;
    }
  }

  function closeRidePaymentModal() {
    stopRidePaymentPolling();
    ridePaymentModalOverlayEl.hidden = true;
    ridePaymentModalContentEl.innerHTML = "";
  }

  if (ridePaymentModalCloseButtonEl) {
    ridePaymentModalCloseButtonEl.addEventListener("click", closeRidePaymentModal);
  }

  function getMercadoPagoPublicKey() {
    if (mercadoPagoPublicKey !== null) {
      return Promise.resolve(mercadoPagoPublicKey);
    }

    return fetch("/api/config")
      .then(function (response) {
        return response.json();
      })
      .then(function (config) {
        mercadoPagoPublicKey = (config && config.mercadoPagoPublicKey) || "";
        return mercadoPagoPublicKey;
      })
      .catch(function () {
        mercadoPagoPublicKey = "";
        return "";
      });
  }

  function getMercadoPagoInstance(publicKey) {
    if (!mercadoPagoInstance && window.MercadoPago) {
      mercadoPagoInstance = new window.MercadoPago(publicKey, { locale: "pt-BR" });
    }
    return mercadoPagoInstance;
  }

  // Enquanto o cliente espera o pagamento (Pix escaneado, ou webhook do
  // cartão confirmando), essa função consulta a corrida a cada poucos
  // segundos - assim que ela sai de "Aguardando pagamento" (o servidor já
  // promoveu ela pra "Novo" assim que o pagamento foi confirmado por
  // trás), a tela troca sozinha pro acompanhamento da corrida.
  function waitForRidePaymentConfirmation(rideId, onCancelled) {
    stopRidePaymentPolling();
    ridePaymentPollTimer = window.setInterval(function () {
      fetch("/api/rides/" + encodeURIComponent(rideId))
        .then(function (response) {
          return response.json();
        })
        .then(function (data) {
          if (!data || !data.ride) {
            return;
          }
          if (data.ride.status === "Cancelada") {
            stopRidePaymentPolling();
            closeRidePaymentModal();
            if (onCancelled) {
              onCancelled();
            }
            return;
          }
          if (data.ride.status !== "Aguardando pagamento") {
            stopRidePaymentPolling();
            closeRidePaymentModal();
            window.appDatabase.saveCurrentRideId(rideId);
            showTracking(rideId);
          }
        })
        .catch(function () {});
    }, 4000);
  }

  function cancelRideFromPaymentModal(rideId) {
    fetch("/api/rides/" + encodeURIComponent(rideId) + "/cancel", { method: "POST" }).catch(function () {});
    stopRidePaymentPolling();
    closeRidePaymentModal();
  }

  function startRidePixPayment(ride) {
    openRidePaymentModal(
      "<h3>Pagar com Pix</h3>" + '<p class="muted-copy">Gerando o código Pix da corrida...</p>'
    );

    fetch("/api/rides/pix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rideId: ride.id })
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          openRidePaymentModal(
            "<h3>Pagar com Pix</h3>" +
              '<div class="inline-message" data-state="error">' +
              escapeHtml((result.data && result.data.error) || "Não foi possível gerar o Pix.") +
              "</div>" +
              '<button class="secondary-button" type="button" id="ride-payment-cancel-button">Cancelar corrida</button>'
          );
          bindRidePaymentCancelButton(ride.id);
          return;
        }

        openRidePaymentModal(
          "<h3>Pagar com Pix</h3>" +
            '<p class="muted-copy">Escaneie o QR code no app do seu banco ou copie o código abaixo. O taxista só vê seu pedido depois que o pagamento for confirmado.</p>' +
            (result.data.qrCodeBase64
              ? '<img class="pix-qr-image" alt="QR code Pix" src="data:image/png;base64,' + result.data.qrCodeBase64 + '" />'
              : "") +
            '<textarea class="field-textarea pix-copy-paste" id="ride-pix-copy-code" readonly>' +
            escapeHtml(result.data.qrCode || "") +
            "</textarea>" +
            '<button class="secondary-button" type="button" id="ride-pix-copy-button">Copiar código</button>' +
            '<p class="muted-copy" id="ride-pix-wait-message">Aguardando confirmação do pagamento...</p>' +
            '<button class="secondary-button danger-button" type="button" id="ride-payment-cancel-button">Cancelar corrida</button>'
        );

        var copyButtonEl = document.getElementById("ride-pix-copy-button");
        if (copyButtonEl) {
          copyButtonEl.addEventListener("click", function () {
            var codeEl = document.getElementById("ride-pix-copy-code");
            codeEl.select();
            document.execCommand("copy");
            copyButtonEl.textContent = "Código copiado!";
          });
        }

        bindRidePaymentCancelButton(ride.id);
        waitForRidePaymentConfirmation(ride.id, function () {
          requestMessageEl.textContent = "A corrida foi cancelada.";
        });
      })
      .catch(function () {
        openRidePaymentModal(
          "<h3>Pagar com Pix</h3>" +
            '<div class="inline-message" data-state="error">Não foi possível gerar o Pix agora.</div>' +
            '<button class="secondary-button" type="button" id="ride-payment-cancel-button">Cancelar corrida</button>'
        );
        bindRidePaymentCancelButton(ride.id);
      });
  }

  function startRideCardPayment(ride) {
    openRidePaymentModal(
      "<h3>Pagar com cartão</h3>" +
        '<div id="ride-card-payment-brick-container"></div>' +
        '<div class="inline-message" id="ride-card-payment-message"></div>' +
        '<button class="secondary-button" type="button" id="ride-payment-cancel-button">Cancelar corrida</button>'
    );
    bindRidePaymentCancelButton(ride.id);

    getMercadoPagoPublicKey().then(function (publicKey) {
      if (!publicKey || !window.MercadoPago) {
        openRidePaymentModal(
          "<h3>Pagar com cartão</h3>" +
            '<div class="inline-message" data-state="error">Pagamento com cartão ainda não foi configurado.</div>' +
            '<button class="secondary-button" type="button" id="ride-payment-cancel-button">Cancelar corrida</button>'
        );
        bindRidePaymentCancelButton(ride.id);
        return;
      }

      var mp = getMercadoPagoInstance(publicKey);
      var bricksBuilder = mp.bricks();

      bricksBuilder.create("cardPayment", "ride-card-payment-brick-container", {
        initialization: { amount: ride.quotedPrice },
        callbacks: {
          onReady: function () {},
          onError: function () {
            var messageEl = document.getElementById("ride-card-payment-message");
            if (messageEl) {
              messageEl.textContent = "Confira os dados do cartão e tente novamente.";
            }
          },
          onSubmit: function (formData, additionalData) {
            return new Promise(function (resolve, reject) {
              fetch("/api/rides/card", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  rideId: ride.id,
                  token: formData.token,
                  paymentMethodId: formData.payment_method_id,
                  paymentTypeId: additionalData ? additionalData.paymentTypeId : "credit_card",
                  installments: formData.installments
                })
              })
                .then(function (response) {
                  return response.json().then(function (data) {
                    return { ok: response.ok, data: data };
                  });
                })
                .then(function (result) {
                  if (result.ok && result.data.paymentStatus === "pago") {
                    openRidePaymentModal(
                      "<h3>Pagamento aprovado</h3>" +
                        '<div class="inline-message" data-state="success">Seu pagamento foi confirmado. Procurando um taxista...</div>'
                    );
                    window.setTimeout(function () {
                      closeRidePaymentModal();
                      window.appDatabase.saveCurrentRideId(ride.id);
                      showTracking(ride.id);
                    }, 1200);
                    resolve();
                    return;
                  }

                  var messageEl = document.getElementById("ride-card-payment-message");
                  if (messageEl) {
                    messageEl.textContent =
                      (result.data && result.data.error) ||
                      "O pagamento não foi aprovado. Tente outro cartão ou escolha outra forma de pagamento.";
                  }
                  reject();
                })
                .catch(function () {
                  var messageEl = document.getElementById("ride-card-payment-message");
                  if (messageEl) {
                    messageEl.textContent = "Não foi possível processar o pagamento agora.";
                  }
                  reject();
                });
            });
          }
        }
      });
    });
  }

  function bindRidePaymentCancelButton(rideId) {
    var cancelButtonEl = document.getElementById("ride-payment-cancel-button");
    if (cancelButtonEl) {
      cancelButtonEl.addEventListener("click", function () {
        cancelRideFromPaymentModal(rideId);
        requestMessageEl.textContent = "";
      });
    }
  }

  submitButtonEl.addEventListener("click", function () {
    if (!pickupCoords) {
      requestMessageEl.textContent =
        "Não conseguimos identificar seu local de partida. Ative a localização ou digite seu endereço e escolha uma sugestão.";
      return;
    }

    if (!destinationCoords) {
      requestMessageEl.textContent = "Digite o destino e escolha uma das sugestões da lista.";
      return;
    }

    var chosenPaymentMethod = paymentMethodSelectEl ? paymentMethodSelectEl.value : "Dinheiro";

    var payload = {
      customerId: customerSession.customerId || "",
      customerName: nameInputEl.value.trim(),
      customerPhone: phoneInputEl.value.trim(),
      pickupLat: pickupCoords.lat,
      pickupLng: pickupCoords.lng,
      pickupLabel: pickupLabelInputEl.value.trim(),
      destinationLabel: destinationInputEl.value.trim(),
      destinationLat: destinationCoords.lat,
      destinationLng: destinationCoords.lng,
      notes: notesInputEl.value.trim(),
      paymentMethod: chosenPaymentMethod
    };

    if (!payload.customerName || !payload.customerPhone) {
      requestMessageEl.textContent = "Preencha seu nome e telefone.";
      return;
    }

    if (!payload.pickupLabel) {
      requestMessageEl.textContent = "Informe a rua ou um ponto de referência de onde você está.";
      return;
    }

    submitButtonEl.disabled = true;
    requestMessageEl.textContent = "Enviando pedido...";

    fetch("/api/rides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        submitButtonEl.disabled = false;
        if (!result.ok) {
          requestMessageEl.textContent = (result.body && result.body.error) || "Não foi possível pedir a corrida.";
          return;
        }
        requestMessageEl.textContent = "";

        var createdRide = result.body.ride;

        // Dinheiro: a corrida já nasce visível pro taxista, igual sempre
        // funcionou - vai direto pro acompanhamento.
        if (createdRide.status !== "Aguardando pagamento") {
          window.appDatabase.saveCurrentRideId(createdRide.id);
          showTracking(createdRide.id);
          return;
        }

        // Pix/cartão: a corrida existe, mas só é anunciada pro taxista
        // depois que o pagamento for confirmado - por isso ainda não salva
        // o id como "corrida atual" (se o cliente fechar o app agora, o
        // pedido fica só aguardando pagamento, sem incomodar taxista
        // nenhum).
        if (chosenPaymentMethod === "Pix") {
          startRidePixPayment(createdRide);
          return;
        }

        if (chosenPaymentMethod === "Cartão") {
          startRideCardPayment(createdRide);
          return;
        }
      })
      .catch(function () {
        submitButtonEl.disabled = false;
        requestMessageEl.textContent = "Não foi possível falar com o servidor agora.";
      });
  });

  function initTrackingMap() {
    if (trackingMap) {
      return;
    }
    trackingMap = window.L.map("ride-tracking-map").setView(MORRETES_CENTER, 14);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
      maxZoom: 19
    }).addTo(trackingMap);
  }

  var STATUS_LABELS = {
    "Aguardando pagamento": "Aguardando confirmação do pagamento",
    Novo: "Procurando taxista...",
    Aceita: "Taxista aceitou sua corrida",
    "A caminho": "Taxista a caminho",
    "Em andamento": "Corrida em andamento",
    Concluída: "Corrida concluída",
    Cancelada: "Corrida cancelada"
  };

  function renderTracking(ride) {
    statusPillEl.textContent = STATUS_LABELS[ride.status] || ride.status;

    initTrackingMap();

    var pickupLatLng = [ride.pickupLat, ride.pickupLng];
    if (!trackingPickupMarker) {
      trackingPickupMarker = window.L.marker(pickupLatLng, { title: "Local de partida" }).addTo(trackingMap);
      trackingMap.setView(pickupLatLng, 15);
    }

    if (ride.driverLat != null && ride.driverLng != null) {
      var driverLatLng = [ride.driverLat, ride.driverLng];
      if (!trackingDriverMarker) {
        trackingDriverMarker = window.L.marker(driverLatLng, { title: ride.driverName || "Taxista" }).addTo(trackingMap);
      } else {
        trackingDriverMarker.setLatLng(driverLatLng);
      }
      var bounds = window.L.latLngBounds([pickupLatLng, driverLatLng]);
      trackingMap.fitBounds(bounds, { padding: [30, 30] });
    }

    var html = "";
    if (ride.driverName) {
      html += "<p><strong>Taxista:</strong> " + ride.driverName + "</p>";
    }
    if (ride.destinationLabel) {
      html += "<p><strong>Destino:</strong> " + ride.destinationLabel + "</p>";
    }
    if (ride.quotedPrice != null) {
      html +=
        "<p><strong>Valor da corrida:</strong> " +
        formatMoney(ride.quotedPrice) +
        (ride.estimatedDistanceKm != null ? " · " + ride.estimatedDistanceKm + " km" : "") +
        "</p>";
    }
    trackingDetailsEl.innerHTML = html;

    var isFinal = ride.status === "Concluída" || ride.status === "Cancelada";
    cancelButtonEl.hidden = isFinal;

    if (isFinal) {
      stopPolling();
      disconnectSocket();
      window.appDatabase.clearCurrentRideId();
      trackingMessageEl.textContent =
        ride.status === "Concluída" ? "Corrida concluída. Obrigado!" : "Essa corrida foi cancelada.";
    }
  }

  function showTracking(rideId) {
    requestScreenEl.hidden = true;
    trackingScreenEl.hidden = false;
    startPolling(rideId);
    connectSocket(rideId);
  }

  function showRequestForm() {
    trackingScreenEl.hidden = true;
    requestScreenEl.hidden = false;
    stopPolling();
    disconnectSocket();

    destinationInputEl.value = "";
    destinationCoords = null;
    fareEstimateHintEl.hidden = true;
    confirmationMapEl.hidden = true;
    hideSuggestions(pickupSuggestionsEl);
    hideSuggestions(destinationSuggestionsEl);

    if (!pickupCoords) {
      initPickupLocation();
    }
  }

  // WebSocket: avisa na hora quando o status muda ou o taxista se move, sem
  // depender só do polling (que fica de reforço/fallback, num intervalo bem
  // mais espaçado que antes).
  function connectSocket(rideId) {
    disconnectSocket();
    socketHandle = window.appDatabase.connectRideSocket(rideId, function () {
      pollRide(rideId);
    });
  }

  function disconnectSocket() {
    if (socketHandle) {
      socketHandle.close();
      socketHandle = null;
    }
  }

  function pollRide(rideId) {
    fetch("/api/rides/" + encodeURIComponent(rideId))
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          stopPolling();
          window.appDatabase.clearCurrentRideId();
          showRequestForm();
          return;
        }
        renderTracking(result.body.ride);
      })
      .catch(function () {});
  }

  function startPolling(rideId) {
    pollRide(rideId);
    stopPolling();
    // O WebSocket já avisa na hora quando algo muda; esse polling fica só
    // como reforço/fallback, num intervalo bem mais espaçado que os 4s de
    // antes.
    pollTimer = window.setInterval(function () {
      pollRide(rideId);
    }, 12000);
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  cancelButtonEl.addEventListener("click", function () {
    var rideId = window.appDatabase.getCurrentRideId();
    if (!rideId) {
      return;
    }
    cancelButtonEl.disabled = true;
    fetch("/api/rides/" + encodeURIComponent(rideId) + "/cancel", { method: "POST" })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        cancelButtonEl.disabled = false;
        if (!result.ok) {
          trackingMessageEl.textContent = (result.body && result.body.error) || "Não foi possível cancelar.";
          return;
        }
        window.appDatabase.clearCurrentRideId();
        stopPolling();
        showRequestForm();
      })
      .catch(function () {
        cancelButtonEl.disabled = false;
        trackingMessageEl.textContent = "Não foi possível falar com o servidor agora.";
      });
  });

  var existingRideId = window.appDatabase.getCurrentRideId();
  if (existingRideId) {
    trackingScreenEl.hidden = false;
    requestScreenEl.hidden = true;
    startPolling(existingRideId);
    connectSocket(existingRideId);
  } else {
    initPickupLocation();
  }
})();
