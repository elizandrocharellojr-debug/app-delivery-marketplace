// Chat + linha do tempo entre cliente e prestador, dentro do mesmo pedido
// de orçamento. Não exige login - o ID do pedido na URL é a "senha" de
// acesso, igual já fazemos em orders.html e pagar-atendimento.html. A tela
// atualiza sozinha de tempos em tempos pra simular um chat "ao vivo" sem
// precisar de WebSocket.
(function conversaPrestadorPage() {
  "use strict";

  var requestId = new URLSearchParams(window.location.search).get("id") || "";

  var loadingStateEl = document.getElementById("chat-loading-state");
  var notFoundStateEl = document.getElementById("chat-not-found-state");
  var contentStateEl = document.getElementById("chat-content-state");
  var providerNameEl = document.getElementById("chat-provider-name");
  var timelineEl = document.getElementById("chat-timeline");
  var payBannerEl = document.getElementById("chat-pay-banner");
  var payBannerTextEl = document.getElementById("chat-pay-banner-text");
  var payLinkEl = document.getElementById("chat-pay-link");
  var threadEl = document.getElementById("chat-thread");
  var formEl = document.getElementById("chat-message-form");
  var inputEl = document.getElementById("chat-message-input");
  var feedbackEl = document.getElementById("chat-feedback");

  var reviewCardEl = document.getElementById("chat-review-card");
  var reviewFormEl = document.getElementById("chat-review-form");
  var reviewStarsEl = document.getElementById("chat-review-stars");
  var reviewCommentEl = document.getElementById("chat-review-comment");
  var reviewFeedbackEl = document.getElementById("chat-review-feedback");
  var reviewThanksEl = document.getElementById("chat-review-thanks");
  var reviewStarButtons = Array.prototype.slice.call(document.querySelectorAll(".chat-review-star"));
  var selectedRating = 0;
  var reviewBookingId = null;

  var pollTimer = null;
  var lastMessageCount = 0;

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function formatDateTime(value) {
    if (!value) {
      return "";
    }
    var date = new Date(value);
    if (isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  if (!requestId) {
    loadingStateEl.hidden = true;
    notFoundStateEl.hidden = false;
    return;
  }

  function buildTimelineSteps(data) {
    var request = data.request;
    var bookings = data.bookings || [];
    var visitBooking = bookings.filter(function (b) {
      return b.kind === "visita";
    })[0];
    var serviceBooking = bookings.filter(function (b) {
      return b.kind !== "visita";
    })[0];
    var steps = [];
    var pendingPaymentBooking = null;

    steps.push({ label: "Pedido enviado ao prestador", state: "done" });

    if (request.status === "aguardando") {
      steps.push({ label: "Prestador está analisando seu pedido", state: "current" });
      return { steps: steps, pendingPaymentBooking: null };
    }

    if (request.status === "recusado") {
      steps.push({ label: "Prestador não vai conseguir atender esse pedido dessa vez", state: "error" });
      return { steps: steps, pendingPaymentBooking: null };
    }

    // A visita técnica é uma etapa opcional, antes do orçamento final -
    // só entra na linha do tempo quando o prestador pediu uma.
    if (visitBooking) {
      var visitHasFee = Number(visitBooking.price || 0) > 0;

      steps.push({
        label: visitHasFee
          ? "Visita técnica pedida: " + formatMoney(visitBooking.price)
          : "Visita técnica pedida (sem cobrança)",
        state: "done"
      });

      if (visitBooking.status === "cancelado") {
        steps.push({ label: "Visita cancelada pelo prestador", state: "error" });
        return { steps: steps, pendingPaymentBooking: null };
      }

      if (visitHasFee && visitBooking.paymentStatus !== "pago") {
        steps.push({ label: "Aguardando pagamento da visita pra liberar pro prestador", state: "current" });
        return { steps: steps, pendingPaymentBooking: visitBooking };
      }

      if (visitHasFee) {
        steps.push({ label: "Pagamento da visita confirmado", state: "done" });
      }

      if (visitBooking.status !== "concluido") {
        steps.push({ label: "Visita agendada para " + formatDateTime(visitBooking.scheduledAt), state: "current" });
        return { steps: steps, pendingPaymentBooking: null };
      }

      steps.push({ label: "Visita concluída", state: "done" });
    }

    if (request.status === "visita_solicitada") {
      steps.push({ label: "Aguardando o orçamento final do serviço", state: "current" });
      return { steps: steps, pendingPaymentBooking: null };
    }

    // status === "orcamento_enviado"
    steps.push({
      label: "Orçamento enviado: " + formatMoney(request.quotedPrice),
      state: "done"
    });

    if (!serviceBooking || serviceBooking.status === "cancelado") {
      steps.push({ label: "Atendimento cancelado", state: "error" });
      return { steps: steps, pendingPaymentBooking: null };
    }

    if (serviceBooking.paymentStatus === "pago") {
      steps.push({ label: "Pagamento confirmado - o valor fica com o Alloo até concluir", state: "done" });
    } else if (serviceBooking.paymentStatus === "combinado") {
      steps.push({ label: "Combinado pagar em dinheiro, direto com o prestador", state: "done" });
    } else {
      steps.push({ label: "Aguardando pagamento pra confirmar o atendimento", state: "current" });
      return { steps: steps, pendingPaymentBooking: serviceBooking };
    }

    if (serviceBooking.status === "concluido") {
      steps.push({ label: "Atendimento concluído - valor repassado ao prestador", state: "done" });
    } else {
      steps.push({ label: "Atendimento agendado para " + formatDateTime(serviceBooking.scheduledAt), state: "current" });
    }

    return { steps: steps, pendingPaymentBooking: null };
  }

  function renderTimeline(data) {
    var result = buildTimelineSteps(data);

    timelineEl.innerHTML = result.steps
      .map(function (step) {
        return (
          '<li class="chat-timeline-step" data-state="' +
          step.state +
          '"><i class="fas ' +
          (step.state === "done" ? "fa-circle-check" : step.state === "error" ? "fa-circle-xmark" : "fa-circle-dot") +
          '"></i><span>' +
          escapeHtml(step.label) +
          "</span></li>"
        );
      })
      .join("");

    var pendingBooking = result.pendingPaymentBooking;
    if (pendingBooking) {
      payBannerTextEl.textContent =
        (pendingBooking.kind === "visita" ? "Visita técnica: " : "Orçamento aceito: ") +
        formatMoney(pendingBooking.price) +
        ". Falta só pagar pra liberar pro prestador.";
      payLinkEl.href = "./pagar-atendimento.html?id=" + encodeURIComponent(pendingBooking.id);
      payBannerEl.hidden = false;
    } else {
      payBannerEl.hidden = true;
    }
  }

  function renderReviewPrompt(data) {
    var bookings = data.bookings || [];
    var serviceBooking = bookings.filter(function (b) {
      return b.kind !== "visita";
    })[0];

    if (!serviceBooking || serviceBooking.status !== "concluido") {
      reviewCardEl.hidden = true;
      reviewThanksEl.hidden = true;
      return;
    }

    if (serviceBooking.alreadyReviewed) {
      reviewCardEl.hidden = true;
      reviewThanksEl.hidden = false;
      return;
    }

    reviewBookingId = serviceBooking.id;
    reviewCardEl.hidden = false;
    reviewThanksEl.hidden = true;
  }

  function renderThread(messages) {
    threadEl.innerHTML = messages
      .map(function (message) {
        var kind = message.senderType === "system" ? "system" : message.senderType === "provider" ? "provider" : "customer";
        return (
          '<div class="chat-bubble-row" data-kind="' +
          kind +
          '"><div class="chat-bubble">' +
          escapeHtml(message.body) +
          '<span class="chat-bubble-time">' +
          escapeHtml(formatDateTime(message.createdAt)) +
          "</span></div></div>"
        );
      })
      .join("");

    if (messages.length !== lastMessageCount) {
      threadEl.scrollTop = threadEl.scrollHeight;
      lastMessageCount = messages.length;
    }
  }

  function render(data) {
    providerNameEl.textContent = "Prestador: " + (data.providerName || "-");
    renderTimeline(data);
    renderThread(data.messages || []);
    renderReviewPrompt(data);

    loadingStateEl.hidden = true;
    contentStateEl.hidden = false;
  }

  function loadTimeline(isBackgroundRefresh) {
    return fetch("/api/budget-requests/" + encodeURIComponent(requestId))
      .then(function (response) {
        if (!response.ok) {
          throw new Error("not-found");
        }
        return response.json();
      })
      .then(function (data) {
        render(data);
      })
      .catch(function () {
        if (isBackgroundRefresh) {
          return;
        }
        loadingStateEl.hidden = true;
        notFoundStateEl.hidden = false;
        if (pollTimer) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
      });
  }

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();

    var body = inputEl.value.trim();
    if (!body) {
      return;
    }

    feedbackEl.textContent = "";

    fetch("/api/budget-requests/" + encodeURIComponent(requestId) + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: body })
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          feedbackEl.textContent = (result.data && result.data.error) || "Não foi possível enviar a mensagem.";
          return;
        }
        inputEl.value = "";
        loadTimeline(true);
      })
      .catch(function () {
        feedbackEl.textContent = "Não foi possível enviar a mensagem.";
      });
  });

  function paintStars() {
    reviewStarButtons.forEach(function (button) {
      var value = Number(button.dataset.value);
      button.classList.toggle("is-active", value <= selectedRating);
    });
  }

  reviewStarButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      selectedRating = Number(button.dataset.value);
      paintStars();
    });
  });

  if (reviewFormEl) {
    reviewFormEl.addEventListener("submit", function (event) {
      event.preventDefault();

      if (!reviewBookingId) {
        return;
      }

      if (!(selectedRating >= 1)) {
        reviewFeedbackEl.textContent = "Escolha de 1 a 5 estrelas.";
        return;
      }

      reviewFeedbackEl.textContent = "";

      fetch("/api/provider-bookings/" + encodeURIComponent(reviewBookingId) + "/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: selectedRating, comment: reviewCommentEl.value.trim() })
      })
        .then(function (response) {
          return response.json().then(function (data) {
            return { ok: response.ok, data: data };
          });
        })
        .then(function (result) {
          if (!result.ok) {
            reviewFeedbackEl.textContent = (result.data && result.data.error) || "Não foi possível enviar a avaliação.";
            return;
          }
          reviewCardEl.hidden = true;
          reviewThanksEl.hidden = false;
          loadTimeline(true);
        })
        .catch(function () {
          reviewFeedbackEl.textContent = "Não foi possível enviar a avaliação.";
        });
    });
  }

  loadTimeline(false).then(function () {
    pollTimer = window.setInterval(function () {
      loadTimeline(true);
    }, 6000);
  });
})();
