(function taxiPage() {
  "use strict";

  let taxiToken = "";
  let watchId = null;
  let lastSentAt = 0;
  let pollTimer = null;
  let map = null;
  let driverMarker = null;
  let socketHandle = null;
  let skippedRideIds = {};
  const rideMarkers = {};

  const loginScreenEl = document.getElementById("taxi-login-screen");
  const panelScreenEl = document.getElementById("taxi-panel-screen");
  const loginFormEl = document.getElementById("taxi-login-form");
  const loginMessageEl = document.getElementById("taxi-login-message");
  const usernameInputEl = document.getElementById("taxi-username-input");
  const passwordInputEl = document.getElementById("taxi-password-input");
  const logoutButtonEl = document.getElementById("taxi-logout-button");
  const onlineToggleEl = document.getElementById("taxi-online-toggle");
  const onlineToggleLabelEl = document.getElementById("taxi-online-toggle-label");
  const connectionHintEl = document.getElementById("taxi-connection-hint");
  const verificationBannerEl = document.getElementById("taxi-verification-banner");
  const earningsValueEl = document.getElementById("taxi-earnings-value");
  const earningsTripsEl = document.getElementById("taxi-earnings-trips");
  const sheetContentEl = document.getElementById("taxi-sheet-content");
  const mapEl = document.getElementById("taxi-map");
  const menuButtonEl = document.getElementById("taxi-menu-button");
  const menuScreenEl = document.getElementById("taxi-menu-screen");
  const menuCloseButtonEl = document.getElementById("taxi-menu-close-button");
  const menuSummaryEl = document.getElementById("taxi-menu-summary");
  const menuListEl = document.getElementById("taxi-menu-list");

  let isOnline = false;
  let driverVerificationStatus = "aprovado";

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  // Mostra pro taxista como o cliente vai pagar - corrida em dinheiro ele
  // recebe direto na mão (e deve comissão depois); corrida no Pix/cartão já
  // foi paga dentro do app, ele não cobra nada do cliente.
  function paymentMethodLabel(ride) {
    if (ride.paymentMethod === "Pix" || ride.paymentMethod === "Cartão") {
      return "Pago no app (" + ride.paymentMethod + ")";
    }
    return "Cobrar em dinheiro";
  }

  function authorizedFetch(path, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + taxiToken });
    return fetch(path, Object.assign({}, opts, { headers })).then(function (response) {
      if (response.status === 401) {
        showLogin();
        throw new Error("unauthorized");
      }
      return response.json().then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    });
  }

  function ensureMap() {
    if (map || !window.L) {
      return;
    }
    map = window.L.map(mapEl, { zoomControl: false }).setView([-25.4784, -48.8335], 14);
    window.L.control.zoom({ position: "bottomright" }).addTo(map);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
      maxZoom: 19
    }).addTo(map);
  }

  function updateDriverMarker(lat, lng) {
    ensureMap();
    if (!map) {
      return;
    }
    if (!driverMarker) {
      driverMarker = window.L.marker([lat, lng], { title: "Você" }).addTo(map);
      map.setView([lat, lng], 15);
    } else {
      driverMarker.setLatLng([lat, lng]);
    }
  }

  function renderRideMarkers(rides) {
    ensureMap();
    if (!map) {
      return;
    }

    const seenIds = {};
    rides.forEach(function (ride) {
      seenIds[ride.id] = true;
      if (rideMarkers[ride.id]) {
        rideMarkers[ride.id].setLatLng([ride.pickupLat, ride.pickupLng]);
        return;
      }
      const marker = window.L.marker([ride.pickupLat, ride.pickupLng], {
        title: ride.pickupLabel || "Corrida"
      }).addTo(map);
      marker.bindPopup((ride.pickupLabel || "Ponto de partida") + (ride.distanceKm != null ? " · " + ride.distanceKm + " km" : ""));
      rideMarkers[ride.id] = marker;
    });

    Object.keys(rideMarkers).forEach(function (id) {
      if (!seenIds[id]) {
        map.removeLayer(rideMarkers[id]);
        delete rideMarkers[id];
      }
    });
  }

  function renderVerificationBanner(driver) {
    driverVerificationStatus = (driver && driver.verificationStatus) || "aprovado";

    if (driverVerificationStatus === "aprovado") {
      verificationBannerEl.hidden = true;
      delete verificationBannerEl.dataset.state;
      return;
    }

    if (driverVerificationStatus === "recusado") {
      verificationBannerEl.textContent =
        "Seus documentos foram recusados. " + (driver.verificationNote || "Fale com o Alloo pra entender o motivo.");
      verificationBannerEl.dataset.state = "error";
    } else {
      verificationBannerEl.textContent =
        "Seus documentos estão em análise. Você só consegue ficar online depois que forem aprovados.";
      delete verificationBannerEl.dataset.state;
    }
    verificationBannerEl.hidden = false;
  }

  function showPanel(driver) {
    loginScreenEl.hidden = true;
    panelScreenEl.hidden = false;
    renderVerificationBanner(driver);
    ensureMap();
    refreshEarnings();
    startPolling();
    connectSocket();
  }

  function showLogin() {
    taxiToken = "";
    stopWatchingLocation();
    stopPolling();
    disconnectSocket();
    panelScreenEl.hidden = true;
    loginScreenEl.hidden = false;
    passwordInputEl.value = "";
    menuScreenEl.hidden = true;
  }

  loginFormEl.addEventListener("submit", function (event) {
    event.preventDefault();
    loginMessageEl.textContent = "Entrando...";

    fetch("/api/taxi/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: usernameInputEl.value.trim(),
        password: passwordInputEl.value
      })
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          loginMessageEl.textContent = (result.body && result.body.error) || "Não foi possível entrar.";
          return;
        }
        taxiToken = result.body.token;
        loginMessageEl.textContent = "";
        showPanel(result.body.driver);
      })
      .catch(function () {
        loginMessageEl.textContent = "Não foi possível falar com o servidor agora.";
      });
  });

  logoutButtonEl.addEventListener("click", function () {
    if (isOnline) {
      setOnline(false);
    }
    showLogin();
  });

  var STATUS_TIME_FORMAT = { hour: "2-digit", minute: "2-digit" };

  // Menu "Corridas de hoje": mesma ideia da tela de Ganhos/histórico de
  // viagens do app da Uber - lista as corridas já concluídas hoje com
  // horário e valor, e o total ganho no dia.
  function renderMenuRides(rides, totalEarnings, tripCount, commissionBalance) {
    // Saldo com o Alloo: positivo é o que o Alloo deve repassar pro
    // taxista (corrida no Pix/cartão, já descontada a comissão); negativo
    // é o que o taxista deve de comissão (corrida em dinheiro) - mesma
    // ideia do "saldo negativo" que a Uber mostra pro motorista.
    var balanceLabel = commissionBalance < 0 ? "Você deve de comissão" : "O Alloo te deve";
    var balanceClass = commissionBalance < 0 ? "is-negative" : "is-positive";

    menuSummaryEl.innerHTML =
      '<div class="taxi-driver-menu-summary-item"><span>Ganhos hoje</span><strong>' +
      formatMoney(totalEarnings) +
      "</strong></div>" +
      '<div class="taxi-driver-menu-summary-item"><span>Corridas</span><strong>' +
      tripCount +
      "</strong></div>" +
      '<div class="taxi-driver-menu-summary-item taxi-driver-menu-balance ' +
      balanceClass +
      '"><span>' +
      balanceLabel +
      "</span><strong>" +
      formatMoney(Math.abs(commissionBalance)) +
      "</strong></div>";

    if (!rides.length) {
      menuListEl.innerHTML =
        '<div class="taxi-driver-sheet-empty"><i class="fas fa-clock-rotate-left"></i>' +
        "<p>Nenhuma corrida concluída hoje ainda.</p></div>";
      return;
    }

    menuListEl.innerHTML = rides
      .map(function (ride) {
        var time = new Date(ride.updatedAt || ride.createdAt).toLocaleTimeString("pt-BR", STATUS_TIME_FORMAT);
        return (
          '<div class="taxi-menu-ride-card">' +
          '<div class="taxi-menu-ride-card-info">' +
          "<strong>" +
          (ride.destinationLabel || ride.pickupLabel || "Corrida") +
          "</strong>" +
          "<p>" +
          time +
          (ride.estimatedDistanceKm != null ? " · " + ride.estimatedDistanceKm + " km" : "") +
          "</p>" +
          "</div>" +
          '<span class="taxi-menu-ride-card-price">' +
          formatMoney(ride.quotedPrice) +
          "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function openMenu() {
    menuScreenEl.hidden = false;
    menuSummaryEl.innerHTML = "";
    menuListEl.innerHTML = '<p class="muted-copy">Carregando...</p>';

    authorizedFetch("/api/taxi/history").then(function (result) {
      if (!result.ok) {
        menuListEl.innerHTML = '<p class="muted-copy">Não foi possível carregar as corridas de hoje.</p>';
        return;
      }
      renderMenuRides(
        result.body.rides || [],
        result.body.totalEarnings,
        result.body.tripCount,
        result.body.commissionBalance || 0
      );
    });
  }

  function closeMenu() {
    menuScreenEl.hidden = true;
  }

  menuButtonEl.addEventListener("click", openMenu);
  menuCloseButtonEl.addEventListener("click", closeMenu);

  function setOnlineToggleVisual(online) {
    isOnline = online;
    onlineToggleEl.setAttribute("aria-pressed", online ? "true" : "false");
    onlineToggleLabelEl.textContent = online ? "Online" : "Offline";
  }

  function setOnline(online) {
    // Se o motorista ainda não foi aprovado (ou foi recusado), nem tenta -
    // já avisa na hora em vez de deixar o botão "piscar" pra depois voltar.
    if (online && driverVerificationStatus !== "aprovado") {
      verificationBannerEl.hidden = false;
      return;
    }

    authorizedFetch("/api/taxi/online", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ online: online })
    })
      .then(function (result) {
        if (!result.ok) {
          if (result.body && result.body.error) {
            verificationBannerEl.textContent = result.body.error;
            verificationBannerEl.dataset.state = "error";
            verificationBannerEl.hidden = false;
          }
          return;
        }

        setOnlineToggleVisual(online);
        if (online) {
          startWatchingLocation();
        } else {
          stopWatchingLocation();
        }
      })
      .catch(function () {});
  }

  onlineToggleEl.addEventListener("click", function () {
    setOnline(!isOnline);
  });

  function sendLocation(lat, lng) {
    const now = Date.now();
    if (now - lastSentAt < 4000) {
      return;
    }
    lastSentAt = now;
    updateDriverMarker(lat, lng);
    authorizedFetch("/api/taxi/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: lat, lng: lng })
    }).catch(function () {});
  }

  function startWatchingLocation() {
    if (!navigator.geolocation || watchId != null) {
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      function (position) {
        sendLocation(position.coords.latitude, position.coords.longitude);
      },
      function () {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  function stopWatchingLocation() {
    if (watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
  }

  // -- WebSocket: acorda o painel na hora quando algo muda (corrida nova,
  // aceita por outro taxista, status/valor mudou), sem depender só do
  // polling de 15s que fica de reforço/fallback. --
  function connectSocket() {
    disconnectSocket();
    socketHandle = window.appDatabase.connectTaxiDriverSocket(
      taxiToken,
      function () {
        refresh();
      },
      function (status) {
        connectionHintEl.hidden = status !== "disconnected";
      }
    );
  }

  function disconnectSocket() {
    if (socketHandle) {
      socketHandle.close();
      socketHandle = null;
    }
  }

  const STATUS_STEPS = ["Aceita", "A caminho", "Em andamento", "Concluída"];

  function renderActiveRide(ride) {
    const stepIndex = STATUS_STEPS.indexOf(ride.status);

    const nextStatusMap = {
      Aceita: "A caminho",
      "A caminho": "Em andamento",
      "Em andamento": "Concluída"
    };
    const nextStatus = nextStatusMap[ride.status];

    let stepsHtml = '<div class="taxi-active-ride-steps">';
    STATUS_STEPS.forEach(function (status, index) {
      stepsHtml += '<div class="taxi-active-ride-step' + (index <= stepIndex ? " is-done" : "") + '"></div>';
    });
    stepsHtml += "</div>";

    let html =
      '<div class="taxi-active-ride-card">' +
      '<span class="status-pill">' +
      ride.status +
      "</span>" +
      stepsHtml +
      "<p><strong>" +
      (ride.customerName || "Cliente") +
      "</strong> · " +
      (ride.customerPhone || "") +
      "</p>" +
      "<p>Partida: " +
      (ride.pickupLabel || "Local informado no mapa") +
      "</p>" +
      (ride.destinationLabel ? "<p>Destino: " + ride.destinationLabel + "</p>" : "") +
      (ride.notes ? "<p>Observações: " + ride.notes + "</p>" : "");

    // O valor é fechado assim que o cliente pede a corrida (bandeirada + km
    // + minuto, calculado na hora) - o taxista não define nem ajusta preço
    // nenhum, só vê o valor já certo, do jeito que a Uber faz.
    if (ride.quotedPrice != null) {
      html +=
        "<p>Valor da corrida: <strong>" +
        formatMoney(ride.quotedPrice) +
        "</strong>" +
        (ride.estimatedDistanceKm != null ? " · " + ride.estimatedDistanceKm + " km" : "") +
        "</p>" +
        "<p>" +
        paymentMethodLabel(ride) +
        "</p>";
    }

    if (nextStatus) {
      html +=
        '<button class="primary-button taxi-big-advance-button" type="button" id="taxi-advance-button" data-status="' +
        nextStatus +
        '">Avançar para "' +
        nextStatus +
        '"</button>';
    }

    html += "</div>";

    sheetContentEl.innerHTML = html;

    const advanceButton = document.getElementById("taxi-advance-button");
    if (advanceButton) {
      advanceButton.addEventListener("click", function () {
        advanceButton.disabled = true;
        authorizedFetch("/api/taxi/rides/" + encodeURIComponent(ride.id) + "/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: advanceButton.dataset.status })
        }).then(function () {
          if (advanceButton.dataset.status === "Concluída") {
            refreshEarnings();
          }
          refresh();
        });
      });
    }
  }

  function renderOpenRides(rides) {
    const visibleRides = rides.filter(function (ride) {
      return !skippedRideIds[ride.id];
    });

    renderRideMarkers(rides);

    if (!visibleRides.length) {
      sheetContentEl.innerHTML =
        '<div class="taxi-driver-sheet-empty">' +
        '<i class="fas fa-taxi"></i>' +
        (isOnline
          ? "<p>Nenhuma corrida por perto agora. Você está online - assim que alguém pedir, aparece aqui na hora.</p>"
          : "<p>Fique online para começar a receber pedidos de corrida.</p>") +
        "</div>";
      return;
    }

    let html = "";
    if (visibleRides.length > 1) {
      html +=
        '<p class="taxi-request-stack-hint">' +
        visibleRides.length +
        " corridas por perto - a mais próxima aparece primeiro</p>";
    }

    html += visibleRides
      .slice(0, 5)
      .map(function (ride) {
        return (
          '<div class="taxi-request-card">' +
          '<div class="taxi-request-card-top">' +
          "<strong>" +
          (ride.pickupLabel || "Ponto de partida") +
          "</strong>" +
          '<span class="taxi-request-distance">' +
          (ride.distanceKm != null ? ride.distanceKm + " km" : "?") +
          "</span>" +
          "</div>" +
          (ride.destinationLabel
            ? '<p class="taxi-request-card-destination">Destino: ' + ride.destinationLabel + "</p>"
            : "") +
          (ride.quotedPrice != null
            ? '<p class="taxi-request-card-price">Valor da corrida: <strong>' +
              formatMoney(ride.quotedPrice) +
              "</strong>" +
              (ride.estimatedDistanceKm != null ? " · " + ride.estimatedDistanceKm + " km de viagem" : "") +
              "</p>" +
              '<p class="taxi-request-card-payment">' +
              paymentMethodLabel(ride) +
              "</p>"
            : "") +
          '<div class="taxi-request-actions">' +
          '<button class="taxi-skip-button" type="button" data-skip-ride-id="' +
          ride.id +
          '">Agora não</button>' +
          '<button class="taxi-accept-button-big" type="button" data-ride-id="' +
          ride.id +
          '">Aceitar corrida</button>' +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    sheetContentEl.innerHTML = html;

    sheetContentEl.querySelectorAll("[data-ride-id]").forEach(function (button) {
      button.addEventListener("click", function () {
        button.disabled = true;
        authorizedFetch("/api/taxi/rides/" + encodeURIComponent(button.dataset.rideId) + "/accept", {
          method: "POST"
        }).then(function (result) {
          if (!result.ok) {
            window.alert((result.body && result.body.error) || "Não foi possível aceitar essa corrida.");
          }
          refresh();
        });
      });
    });

    sheetContentEl.querySelectorAll("[data-skip-ride-id]").forEach(function (button) {
      button.addEventListener("click", function () {
        skippedRideIds[button.dataset.skipRideId] = true;
        renderOpenRides(rides);
      });
    });
  }

  function refreshEarnings() {
    authorizedFetch("/api/taxi/history").then(function (result) {
      if (!result.ok) {
        return;
      }
      earningsValueEl.textContent = formatMoney(result.body.totalEarnings);
      earningsTripsEl.textContent =
        result.body.tripCount === 1 ? "1 corrida" : result.body.tripCount + " corridas";
    });
  }

  function refresh() {
    authorizedFetch("/api/taxi/rides")
      .then(function (result) {
        if (!result.ok) {
          return;
        }
        if (result.body.myRide) {
          skippedRideIds = {};
          renderActiveRide(result.body.myRide);
          renderRideMarkers([]);
        } else {
          renderOpenRides(result.body.openRides || []);
        }
      })
      .catch(function () {});
  }

  function startPolling() {
    refresh();
    stopPolling();
    // O WebSocket já avisa na hora quando algo muda; esse polling fica só
    // como reforço/fallback (mesmo padrão usado no painel de pedidos da
    // loja), num intervalo bem mais espaçado que os 4s de antes.
    pollTimer = window.setInterval(refresh, 15000);
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }
})();
