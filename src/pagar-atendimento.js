// Página pública de pagamento do orçamento aceito de um prestador de
// serviço. Não exige login (esse fluxo não tem conta de cliente ainda) - o
// próprio ID do atendimento na URL funciona como a "senha" de acesso, igual
// já acontece com o acompanhamento de pedido de loja (orders.html?id=...).
// O link chega pro cliente pelo prestador (WhatsApp/telefone), com o botão
// "Copiar link de pagamento" que aparece no painel dele assim que o
// orçamento é aceito.
(function pagarAtendimentoPage() {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var bookingId = params.get("id") || "";

  var loadingStateEl = document.getElementById("booking-loading-state");
  var notFoundStateEl = document.getElementById("booking-not-found-state");
  var summaryStateEl = document.getElementById("booking-summary-state");
  var providerNameEl = document.getElementById("booking-provider-name");
  var serviceNameEl = document.getElementById("booking-service-name");
  var scheduledAtEl = document.getElementById("booking-scheduled-at");
  var priceEl = document.getElementById("booking-price");
  var alreadyPaidStateEl = document.getElementById("booking-already-paid-state");
  var cancelledStateEl = document.getElementById("booking-cancelled-state");
  var paymentChoiceEl = document.getElementById("booking-payment-choice");
  var paymentAreaEl = document.getElementById("booking-payment-area");
  var payPixButtonEl = document.getElementById("pay-pix-button");
  var payCardButtonEl = document.getElementById("pay-card-button");
  var payCashButtonEl = document.getElementById("pay-cash-button");

  var mercadoPagoPublicKey = null;
  var mercadoPagoInstance = null;
  var paymentPollTimer = null;

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

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  function stopPolling() {
    if (paymentPollTimer) {
      window.clearInterval(paymentPollTimer);
      paymentPollTimer = null;
    }
  }

  if (!bookingId) {
    loadingStateEl.hidden = true;
    notFoundStateEl.hidden = false;
    return;
  }

  function renderBooking(data) {
    var booking = data.booking;

    providerNameEl.innerHTML = "<strong>Prestador:</strong> " + escapeHtml(data.providerName || "-");
    serviceNameEl.innerHTML = "<strong>Serviço:</strong> " + escapeHtml(booking.serviceName || "-");
    scheduledAtEl.innerHTML = "<strong>Quando:</strong> " + escapeHtml(formatDateTime(booking.scheduledAt) || "-");
    priceEl.textContent = formatMoney(booking.price);

    loadingStateEl.hidden = true;
    summaryStateEl.hidden = false;

    if (booking.status === "cancelado") {
      cancelledStateEl.hidden = false;
      paymentChoiceEl.hidden = true;
      return false;
    }

    if (booking.paymentStatus === "pago" || booking.paymentStatus === "combinado") {
      alreadyPaidStateEl.hidden = false;
      alreadyPaidStateEl.innerHTML =
        '<div class="inline-message" data-state="success">' +
        (booking.paymentStatus === "combinado"
          ? "Combinado: você vai pagar esse atendimento em dinheiro, direto com o prestador. Pode fechar essa página."
          : "Esse atendimento já está pago. Obrigado! Pode fechar essa página.") +
        "</div>";
      paymentChoiceEl.hidden = true;
      stopPolling();
      return false;
    }

    // Pagar em dinheiro na hora, direto com o prestador, só faz sentido pro
    // atendimento em si - a visita técnica precisa ser paga pelo app antes,
    // igual já vale pra Pix/cartão (ver a trava equivalente no servidor).
    if (payCashButtonEl) {
      payCashButtonEl.hidden = booking.kind === "visita";
    }

    return true;
  }

  function loadBooking() {
    return fetch("/api/provider-bookings/" + encodeURIComponent(bookingId))
      .then(function (response) {
        if (!response.ok) {
          throw new Error("not-found");
        }
        return response.json();
      })
      .then(function (data) {
        return renderBooking(data);
      })
      .catch(function () {
        loadingStateEl.hidden = true;
        notFoundStateEl.hidden = false;
        return false;
      });
  }

  function waitForPaymentConfirmation() {
    stopPolling();
    paymentPollTimer = window.setInterval(function () {
      fetch("/api/provider-bookings/" + encodeURIComponent(bookingId))
        .then(function (response) {
          return response.json();
        })
        .then(function (data) {
          if (!data || !data.booking) {
            return;
          }
          if (data.booking.paymentStatus === "pago") {
            stopPolling();
            renderBooking(data);
          }
        })
        .catch(function () {});
    }, 4000);
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

  function startPixPayment() {
    paymentChoiceEl.hidden = true;
    paymentAreaEl.innerHTML =
      "<h3>Pagar com Pix</h3>" + '<p class="muted-copy">Gerando o código Pix...</p>';

    fetch("/api/provider-bookings/pix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: bookingId })
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          paymentAreaEl.innerHTML =
            "<h3>Pagar com Pix</h3>" +
            '<div class="inline-message" data-state="error">' +
            escapeHtml((result.data && result.data.error) || "Não foi possível gerar o Pix agora.") +
            "</div>" +
            '<button class="secondary-button" type="button" id="pay-back-button">Voltar</button>';
          bindBackButton();
          return;
        }

        paymentAreaEl.innerHTML =
          "<h3>Pagar com Pix</h3>" +
          '<p class="muted-copy">Escaneie o QR code no app do seu banco ou copie o código abaixo.</p>' +
          (result.data.qrCodeBase64
            ? '<img class="pix-qr-image" alt="QR code Pix" src="data:image/png;base64,' + result.data.qrCodeBase64 + '" />'
            : "") +
          '<textarea class="field-textarea pix-copy-paste" id="booking-pix-copy-code" readonly>' +
          escapeHtml(result.data.qrCode || "") +
          "</textarea>" +
          '<button class="secondary-button" type="button" id="booking-pix-copy-button">Copiar código</button>' +
          '<p class="muted-copy" id="booking-pix-wait-message">Aguardando confirmação do pagamento...</p>' +
          '<button class="secondary-button" type="button" id="pay-back-button">Escolher outra forma de pagamento</button>';

        var copyButtonEl = document.getElementById("booking-pix-copy-button");
        if (copyButtonEl) {
          copyButtonEl.addEventListener("click", function () {
            var codeEl = document.getElementById("booking-pix-copy-code");
            codeEl.select();
            document.execCommand("copy");
            copyButtonEl.textContent = "Código copiado!";
          });
        }

        bindBackButton();
        waitForPaymentConfirmation();
      })
      .catch(function () {
        paymentAreaEl.innerHTML =
          "<h3>Pagar com Pix</h3>" +
          '<div class="inline-message" data-state="error">Não foi possível gerar o Pix agora.</div>' +
          '<button class="secondary-button" type="button" id="pay-back-button">Voltar</button>';
        bindBackButton();
      });
  }

  function startCardPayment(price) {
    paymentChoiceEl.hidden = true;
    paymentAreaEl.innerHTML =
      "<h3>Pagar com cartão</h3>" +
      '<div id="booking-card-payment-brick-container"></div>' +
      '<div class="inline-message" id="booking-card-payment-message"></div>' +
      '<button class="secondary-button" type="button" id="pay-back-button">Escolher outra forma de pagamento</button>';
    bindBackButton();

    getMercadoPagoPublicKey().then(function (publicKey) {
      if (!publicKey || !window.MercadoPago) {
        paymentAreaEl.innerHTML =
          "<h3>Pagar com cartão</h3>" +
          '<div class="inline-message" data-state="error">Pagamento com cartão ainda não foi configurado.</div>' +
          '<button class="secondary-button" type="button" id="pay-back-button">Voltar</button>';
        bindBackButton();
        return;
      }

      var mp = getMercadoPagoInstance(publicKey);
      var bricksBuilder = mp.bricks();

      bricksBuilder.create("cardPayment", "booking-card-payment-brick-container", {
        initialization: { amount: price },
        callbacks: {
          onReady: function () {},
          onError: function () {
            var messageEl = document.getElementById("booking-card-payment-message");
            if (messageEl) {
              messageEl.textContent = "Confira os dados do cartão e tente novamente.";
            }
          },
          onSubmit: function (formData, additionalData) {
            return new Promise(function (resolve, reject) {
              fetch("/api/provider-bookings/card", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  bookingId: bookingId,
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
                    paymentAreaEl.innerHTML =
                      "<h3>Pagamento aprovado</h3>" +
                      '<div class="inline-message" data-state="success">Pagamento confirmado. Obrigado! Pode fechar essa página.</div>';
                    resolve();
                    return;
                  }

                  var messageEl = document.getElementById("booking-card-payment-message");
                  if (messageEl) {
                    messageEl.textContent =
                      (result.data && result.data.error) ||
                      "O pagamento não foi aprovado. Tente outro cartão ou escolha outra forma de pagamento.";
                  }
                  reject();
                })
                .catch(function () {
                  var messageEl = document.getElementById("booking-card-payment-message");
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

  function chooseCashPayment() {
    paymentChoiceEl.hidden = true;
    paymentAreaEl.innerHTML =
      "<h3>Pagar em dinheiro</h3>" + '<p class="muted-copy">Combinando com o prestador...</p>';

    fetch("/api/provider-bookings/cash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: bookingId })
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          paymentAreaEl.innerHTML =
            "<h3>Pagar em dinheiro</h3>" +
            '<div class="inline-message" data-state="error">' +
            escapeHtml((result.data && result.data.error) || "Não foi possível combinar o pagamento em dinheiro agora.") +
            "</div>" +
            '<button class="secondary-button" type="button" id="pay-back-button">Voltar</button>';
          bindBackButton();
          return;
        }

        paymentAreaEl.innerHTML =
          "<h3>Combinado!</h3>" +
          '<div class="inline-message" data-state="success">Você vai pagar esse atendimento em dinheiro, direto com o prestador, no dia do serviço. Pode fechar essa página.</div>';
      })
      .catch(function () {
        paymentAreaEl.innerHTML =
          "<h3>Pagar em dinheiro</h3>" +
          '<div class="inline-message" data-state="error">Não foi possível combinar o pagamento em dinheiro agora.</div>' +
          '<button class="secondary-button" type="button" id="pay-back-button">Voltar</button>';
        bindBackButton();
      });
  }

  function bindBackButton() {
    var backButtonEl = document.getElementById("pay-back-button");
    if (backButtonEl) {
      backButtonEl.addEventListener("click", function () {
        stopPolling();
        paymentAreaEl.innerHTML = "";
        paymentChoiceEl.hidden = false;
      });
    }
  }

  loadBooking().then(function (canPay) {
    if (!canPay) {
      return;
    }

    payPixButtonEl.addEventListener("click", startPixPayment);
    payCardButtonEl.addEventListener("click", function () {
      fetch("/api/provider-bookings/" + encodeURIComponent(bookingId))
        .then(function (response) {
          return response.json();
        })
        .then(function (data) {
          startCardPayment(data.booking.price);
        })
        .catch(function () {
          startCardPayment(0);
        });
    });
    if (payCashButtonEl) {
      payCashButtonEl.addEventListener("click", chooseCashPayment);
    }
  });
})();
