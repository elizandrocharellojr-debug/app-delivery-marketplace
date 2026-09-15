(function cartPage() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  var cartContentEl = document.getElementById("cart-content");
  var paymentModalOverlayEl = document.getElementById("payment-modal-overlay");
  var paymentModalContentEl = document.getElementById("payment-modal-content");
  var paymentModalCloseButtonEl = document.getElementById("payment-modal-close-button");
  var ONLINE_PAYMENT_METHODS = ["Pix", "Cartão (crédito ou débito)"];
  var state = {
    addressEditorOpen: false,
    addressDraft: null,
    addressSaveTimer: null,
    addingAddress: false,
    coupon: null,
    couponMessage: "",
    mercadoPagoPublicKey: null,
    mercadoPagoInstance: null,
    pixPollTimer: null,
  };

  function isOnlinePaymentMethod(method) {
    return ONLINE_PAYMENT_METHODS.indexOf(method) >= 0;
  }

  function openPaymentModal(html) {
    paymentModalContentEl.innerHTML = html;
    paymentModalOverlayEl.hidden = false;
  }

  function closePaymentModal() {
    if (state.pixPollTimer) {
      window.clearInterval(state.pixPollTimer);
      state.pixPollTimer = null;
    }
    paymentModalOverlayEl.hidden = true;
    paymentModalContentEl.innerHTML = "";
  }

  if (paymentModalCloseButtonEl) {
    paymentModalCloseButtonEl.addEventListener("click", closePaymentModal);
  }

  function getMercadoPagoPublicKey() {
    if (state.mercadoPagoPublicKey !== null) {
      return Promise.resolve(state.mercadoPagoPublicKey);
    }

    return window
      .fetch("/api/config")
      .then(function (response) {
        return response.json();
      })
      .then(function (config) {
        state.mercadoPagoPublicKey = (config && config.mercadoPagoPublicKey) || "";
        return state.mercadoPagoPublicKey;
      })
      .catch(function () {
        state.mercadoPagoPublicKey = "";
        return "";
      });
  }

  function getMercadoPagoInstance(publicKey) {
    if (!state.mercadoPagoInstance && window.MercadoPago) {
      state.mercadoPagoInstance = new window.MercadoPago(publicKey, { locale: "pt-BR" });
    }
    return state.mercadoPagoInstance;
  }

  function startPixPayment(order) {
    var customerSession = window.appDatabase.getCustomerSession();
    var payerEmail = (customerSession && customerSession.email) || "";

    openPaymentModal(
      '<h3>Pagar com Pix</h3>' +
      '<p class="muted-copy">Gerando o código Pix do seu pedido...</p>'
    );

    window
      .fetch("/api/payments/pix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id, payerEmail: payerEmail }),
      })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          openPaymentModal(
            '<h3>Pagar com Pix</h3>' +
            '<div class="inline-message" data-state="error">' +
            window.appDatabase.escapeHtml((result.data && result.data.error) || "Não foi possível gerar o Pix.") +
            "</div>" +
            '<p class="muted-copy">Seu pedido já foi registrado. Você pode ir em Pedidos e combinar o pagamento direto com a loja.</p>' +
            '<button class="primary-button" type="button" id="payment-modal-go-orders">Ver meus pedidos</button>'
          );
          bindGoToOrders(order.id);
          return;
        }

        openPaymentModal(
          '<h3>Pagar com Pix</h3>' +
          '<p class="muted-copy">Escaneie o QR code no app do seu banco ou copie o código abaixo.</p>' +
          (result.data.qrCodeBase64
            ? '<img class="pix-qr-image" alt="QR code Pix" src="data:image/png;base64,' +
              result.data.qrCodeBase64 +
              '" />'
            : "") +
          '<textarea class="field-textarea pix-copy-paste" id="pix-copy-code" readonly>' +
          window.appDatabase.escapeHtml(result.data.qrCode || "") +
          "</textarea>" +
          '<button class="secondary-button" type="button" id="pix-copy-button">Copiar código</button>' +
          '<p class="muted-copy" id="pix-wait-message">Aguardando confirmação do pagamento...</p>'
        );

        var copyButtonEl = document.getElementById("pix-copy-button");
        if (copyButtonEl) {
          copyButtonEl.addEventListener("click", function () {
            var codeEl = document.getElementById("pix-copy-code");
            codeEl.select();
            document.execCommand("copy");
            copyButtonEl.textContent = "Código copiado!";
          });
        }

        state.pixPollTimer = window.setInterval(function () {
          window
            .fetch("/api/orders/" + encodeURIComponent(order.id))
            .then(function (response) {
              return response.json();
            })
            .then(function (data) {
              if (data && data.order && data.order.paymentStatus === "pago") {
                window.clearInterval(state.pixPollTimer);
                state.pixPollTimer = null;
                var waitMessageEl = document.getElementById("pix-wait-message");
                if (waitMessageEl) {
                  waitMessageEl.textContent = "Pagamento confirmado! Redirecionando...";
                }
                window.setTimeout(function () {
                  window.location.href = "./orders.html?highlight=" + order.id;
                }, 1200);
              }
            })
            .catch(function () {});
        }, 4000);
      })
      .catch(function () {
        openPaymentModal(
          '<h3>Pagar com Pix</h3>' +
          '<div class="inline-message" data-state="error">Não foi possível gerar o Pix agora.</div>' +
          '<button class="primary-button" type="button" id="payment-modal-go-orders">Ver meus pedidos</button>'
        );
        bindGoToOrders(order.id);
      });
  }

  function startCardPayment(order) {
    var customerSession = window.appDatabase.getCustomerSession();
    var payerEmail = (customerSession && customerSession.email) || "";

    openPaymentModal(
      '<h3>Pagar com cartao</h3>' +
      '<div id="card-payment-brick-container"></div>' +
      '<div class="inline-message" id="card-payment-message"></div>'
    );

    getMercadoPagoPublicKey().then(function (publicKey) {
      if (!publicKey || !window.MercadoPago) {
        openPaymentModal(
          '<h3>Pagar com cartao</h3>' +
          '<div class="inline-message" data-state="error">Pagamento com cartao ainda não foi configurado.</div>' +
          '<p class="muted-copy">Seu pedido já foi registrado. Você pode ir em Pedidos e combinar o pagamento direto com a loja.</p>' +
          '<button class="primary-button" type="button" id="payment-modal-go-orders">Ver meus pedidos</button>'
        );
        bindGoToOrders(order.id);
        return;
      }

      var mp = getMercadoPagoInstance(publicKey);
      var bricksBuilder = mp.bricks();

      bricksBuilder.create("cardPayment", "card-payment-brick-container", {
        initialization: { amount: order.total },
        callbacks: {
          onReady: function () {},
          onError: function () {
            var messageEl = document.getElementById("card-payment-message");
            if (messageEl) {
              messageEl.textContent = "Confira os dados do cartao e tente novamente.";
            }
          },
          onSubmit: function (formData, additionalData) {
            return new Promise(function (resolve, reject) {
              window
                .fetch("/api/payments/card", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    orderId: order.id,
                    token: formData.token,
                    paymentMethodId: formData.payment_method_id,
                    paymentTypeId: additionalData ? additionalData.paymentTypeId : "credit_card",
                    installments: formData.installments,
                    payerEmail: (formData.payer && formData.payer.email) || payerEmail,
                  }),
                })
                .then(function (response) {
                  return response.json().then(function (data) {
                    return { ok: response.ok, data: data };
                  });
                })
                .then(function (result) {
                  if (result.ok && result.data.paymentStatus === "pago") {
                    openPaymentModal(
                      '<h3>Pagamento aprovado</h3>' +
                      '<div class="inline-message" data-state="success">Seu pagamento foi confirmado.</div>'
                    );
                    window.setTimeout(function () {
                      window.location.href = "./orders.html?highlight=" + order.id;
                    }, 1200);
                    resolve();
                    return;
                  }

                  var messageEl = document.getElementById("card-payment-message");
                  if (messageEl) {
                    messageEl.textContent =
                      (result.data && result.data.error) ||
                      "O pagamento não foi aprovado. Tente outro cartao ou escolha outra forma de pagamento.";
                  }
                  reject();
                })
                .catch(function () {
                  var messageEl = document.getElementById("card-payment-message");
                  if (messageEl) {
                    messageEl.textContent = "Não foi possível processar o pagamento agora.";
                  }
                  reject();
                });
            });
          },
        },
      });
    });
  }

  function bindGoToOrders(orderId) {
    var goButtonEl = document.getElementById("payment-modal-go-orders");
    if (goButtonEl) {
      goButtonEl.addEventListener("click", function () {
        window.location.href = "./orders.html?highlight=" + orderId;
      });
    }
  }

  function getAddressDraft() {
    if (!state.addressDraft) {
      state.addressDraft = window.appDatabase.getProfile();
    }

    return state.addressDraft;
  }

  function saveAddressDraft() {
    if (state.addressSaveTimer) {
      window.clearTimeout(state.addressSaveTimer);
    }

    state.addressSaveTimer = window.setTimeout(function () {
      window.appDatabase.saveProfile(getAddressDraft());
      state.addressSaveTimer = null;
      render();
    }, 150);
  }

  function renderAddressEditor(profile) {
    if (!state.addressEditorOpen) {
      return "";
    }

    return (
      '<div class="addresses-list checkout-addresses-list">' +
      profile.addresses
        .map(function (address) {
          var formattedAddress = window.appDatabase.formatAddress(address) || "Preencha o endereço";
          return (
            '<div class="address-card compact-address-card" data-address-id="' +
            address.id +
            '">' +
            '<div class="address-card-top">' +
            "<strong>" +
            formattedAddress +
            "</strong>" +
            '<label class="item-toggle">' +
            '<input type="radio" name="checkout-default-address" value="' +
            address.id +
            '" ' +
            (address.id === profile.defaultAddressId ? "checked" : "") +
            ' /></label>' +
            "</div>" +
          "</div>"
          );
        })
        .join("") +
      (state.addingAddress
        ? '<div class="address-card compact-address-card add-address-card">' +
          '<strong>Novo endereço</strong>' +
          '<div class="compact-address-grid">' +
          '<input class="address-input" id="new-address-street" type="text" placeholder="Rua" />' +
          '<input class="address-input" id="new-address-number" type="text" placeholder="Número" />' +
          '<input class="address-input" id="new-address-district" type="text" placeholder="Bairro" />' +
          '<input class="address-input" id="new-address-city" type="text" placeholder="Cidade" />' +
          '<input class="address-input" id="new-address-zipcode" type="text" placeholder="CEP" />' +
          "</div>" +
          '<div class="checkout-actions compact-actions">' +
          '<button class="secondary-button" type="button" id="cancel-add-checkout-address-button">Cancelar</button>' +
          '<button class="primary-button" type="button" id="save-new-checkout-address-button">OK</button>' +
          "</div>" +
          "</div>"
        : "") +
      '<div class="checkout-inline-actions">' +
      '<button class="secondary-button small-button" type="button" id="add-checkout-address-button">+ Adicionar endereço</button>' +
      "</div>" +
      '<div class="checkout-actions compact-actions">' +
      '<button class="primary-button" type="button" id="confirm-checkout-address-button">OK</button>' +
      "</div>" +
      "</div>"
    );
  }

  function render() {
    var cart = window.appDatabase.getCartDetailed();
    var profile = getAddressDraft();

    if (!cart.store || !cart.items.length) {
      cartContentEl.innerHTML =
        '<div class="empty-state">Seu carrinho está vazio. Escolha uma loja e adicione itens.</div>';
      return;
    }

    var currentAddress =
      profile.addresses.find(function (item) {
        return item.id === profile.defaultAddressId;
      }) || profile.addresses[0];
    var paymentOptions = ["Pix", "Cartão (crédito ou débito)", "Cartao na entrega", "Dinheiro"];
    var checkoutDisabled = !cart.isOpen;
    var storeStatusLabel = cart.store.isActive === false
      ? "Loja inativa"
      : cart.isOpen
      ? "Loja aberta"
      : "Fora do horário";

    cartContentEl.innerHTML =
      '<div class="store-card-large checkout-card">' +
      "<h3>" +
      window.appDatabase.escapeHtml(cart.store.name) +
      "</h3>" +
      '<p class="muted-copy">Confira os itens, escolha o pagamento e confirme seu pedido.</p>' +
      '<div class="status-row checkout-status-row">' +
      '<div class="status-pill">' +
      storeStatusLabel +
      "</div>" +
      '<div class="status-pill">Horário: ' +
      (cart.store.openingHours || "Consulte a loja") +
      "</div>" +
      "</div>" +
      '<div class="cart-items">' +
      cart.items
        .map(function (item) {
          return (
            '<div class="cart-item-row">' +
            "<div>" +
            "<strong>" +
            window.appDatabase.escapeHtml(item.name) +
            "</strong>" +
            "<span>" +
            window.appDatabase.formatMoney(item.price) +
            "</span>" +
            "</div>" +
            '<div class="qty-controls">' +
            '<button class="qty-btn" type="button" data-action="decrease" data-item="' +
            item.itemId +
            '">-</button>' +
            "<strong>" +
            item.quantity +
            "</strong>" +
            '<button class="qty-btn" type="button" data-action="increase" data-item="' +
            item.itemId +
            '">+</button>' +
            "</div>" +
            "</div>"
          );
        })
        .join("") +
      "</div>" +
      '<div class="checkout-grid">' +
      '<section class="form-card checkout-panel">' +
      '<div class="section-header"><h2>Entrega</h2></div>' +
      '<div class="checkout-address-card">' +
      "<strong>" +
      (currentAddress ? window.appDatabase.formatAddress(currentAddress) : "Defina um endereço") +
      "</strong>" +
      "<span>" +
      (currentAddress && currentAddress.district
        ? "Bairro: " + currentAddress.district
        : "Selecione um bairro para calcular o frete") +
      "</span>" +
      "</div>" +
      '<button class="secondary-button" type="button" id="toggle-checkout-address-editor">' +
      (state.addressEditorOpen ? "Ocultar endereços" : "Alterar endereço") +
      "</button>" +
      renderAddressEditor(profile) +
      '<label class="field">' +
      "<span>Pagamento</span>" +
      '<select class="field-select" id="payment-method">' +
      paymentOptions
        .map(function (option) {
          return '<option value="' + option + '">' + option + "</option>";
        })
        .join("") +
      "</select>" +
      "</label>" +
      '<div class="checkout-change-box" id="checkout-change-box" hidden>' +
      '<label class="checkbox-field">' +
      '<input type="checkbox" id="checkout-needs-change" />' +
      "<span>Preciso de troco</span>" +
      "</label>" +
      '<label class="field" id="checkout-change-amount-field" hidden>' +
      "<span>Troco para quanto?</span>" +
      '<input type="number" step="0.01" min="0" class="address-input" id="checkout-change-amount" placeholder="Ex.: 50,00" />' +
      "</label>" +
      "</div>" +
      '<label class="field">' +
      "<span>Observações do pedido</span>" +
      '<textarea class="field-textarea" id="order-notes" placeholder="Ex.: sem cebola, tocar campainha"></textarea>' +
      "</label>" +
      "</section>" +
      '<section class="form-card checkout-panel">' +
      '<div class="section-header"><h2>Cupom de desconto</h2></div>' +
      '<div class="coupon-box">' +
      (state.coupon
        ? '<div class="coupon-applied">' +
          '<span><i class="fas fa-tag"></i> Cupom <strong>' +
          window.appDatabase.escapeHtml(state.coupon.code) +
          "</strong> aplicado</span>" +
          '<button class="secondary-button small-button" type="button" id="remove-coupon-button">Remover</button>' +
          "</div>"
        : '<div class="coupon-input-row">' +
          '<input type="text" class="address-input" id="coupon-code-input" placeholder="Digite o cupom" />' +
          '<button class="secondary-button small-button" type="button" id="apply-coupon-button">Aplicar</button>' +
          "</div>") +
      (state.couponMessage
        ? '<div class="inline-message">' + window.appDatabase.escapeHtml(state.couponMessage) + "</div>"
        : "") +
      "</div>" +
      "</section>" +
      '<section class="form-card checkout-panel">' +
      '<div class="section-header"><h2>Resumo</h2></div>' +
      '<div class="checkout-summary">' +
      "<div><span>Subtotal</span><strong>" +
      window.appDatabase.formatMoney(cart.subtotal) +
      "</strong></div>" +
      "<div><span>Pedido mínimo</span><strong>" +
      window.appDatabase.formatMoney(cart.minOrder || 0) +
      "</strong></div>" +
      "<div><span>Frete para " +
      (currentAddress && currentAddress.district ? currentAddress.district : "seu bairro") +
      "</span><strong>" +
      window.appDatabase.getDeliveryFeeLabelForStore(cart.store, currentAddress) +
      "</strong></div>" +
      (state.coupon
        ? '<div class="checkout-summary-discount"><span>Desconto (' +
          window.appDatabase.escapeHtml(state.coupon.code) +
          ")</span><strong>-" +
          window.appDatabase.formatMoney(state.coupon.discount) +
          "</strong></div>"
        : "") +
      '<div class="checkout-summary-total"><span>Total</span><strong>' +
      window.appDatabase.formatMoney(
        Math.max(
          0,
          cart.subtotal +
            window.appDatabase.getDeliveryFeeForStore(cart.store, currentAddress) -
            (state.coupon ? state.coupon.discount : 0)
        )
      ) +
      "</strong></div>" +
      "</div>" +
      '<div class="checkout-confirm-box">' +
      "<strong>Confirmação do pedido</strong>" +
      "<span>" +
      (cart.store.isActive === false
        ? "A loja está inativa no momento."
        : cart.isOpen
        ? "Seu pedido será enviado para a loja assim que você confirmar."
        : "A loja está ativa, mas fora do horário de funcionamento. Aguarde o horário para pedir.") +
      "</span>" +
      "</div>" +
      '<div class="checkout-actions">' +
      '<button class="secondary-button" type="button" id="clear-cart">Limpar</button>' +
      '<button class="primary-button" type="button" id="finish-order"' +
      (checkoutDisabled ? " disabled" : "") +
      ">Confirmar pedido</button>" +
      "</div>" +
      '<div class="inline-message" id="cart-message"></div>' +
      "</section>" +
      "</div>" +
      "</div>";

    bindEvents();
  }

  function bindEvents() {
    document.querySelectorAll("[data-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        var itemId = button.dataset.item;
        var cart = window.appDatabase.getCartDetailed();
        var targetItem = cart.items.find(function (item) {
          return item.itemId === itemId;
        });

        if (!targetItem) {
          return;
        }

        var nextQuantity =
          button.dataset.action === "increase"
            ? targetItem.quantity + 1
            : targetItem.quantity - 1;

        window.appDatabase.updateCartItemQuantity(itemId, nextQuantity);
        render();
      });
    });

    var clearCartEl = document.getElementById("clear-cart");
    if (clearCartEl) {
      clearCartEl.addEventListener("click", function () {
        window.appDatabase.clearCart();
        state.coupon = null;
        state.couponMessage = "";
        render();
      });
    }

    var applyCouponEl = document.getElementById("apply-coupon-button");
    if (applyCouponEl) {
      applyCouponEl.addEventListener("click", async function () {
        var codeInputEl = document.getElementById("coupon-code-input");
        var code = codeInputEl ? codeInputEl.value.trim() : "";
        var cart = window.appDatabase.getCartDetailed();

        if (!code) {
          state.couponMessage = "Digite um cupom para aplicar.";
          render();
          return;
        }

        applyCouponEl.disabled = true;
        var result = await window.appDatabase.validateCoupon(cart.store.id, code, cart.subtotal);

        if (result && result.error) {
          state.coupon = null;
          state.couponMessage = result.error;
          render();
          return;
        }

        state.coupon = result;
        state.couponMessage = "Cupom aplicado com sucesso!";
        render();
      });
    }

    var removeCouponEl = document.getElementById("remove-coupon-button");
    if (removeCouponEl) {
      removeCouponEl.addEventListener("click", function () {
        state.coupon = null;
        state.couponMessage = "";
        render();
      });
    }

    var paymentMethodSelectEl = document.getElementById("payment-method");
    var changeBoxEl = document.getElementById("checkout-change-box");
    var needsChangeCheckboxEl = document.getElementById("checkout-needs-change");
    var changeAmountFieldEl = document.getElementById("checkout-change-amount-field");

    function syncChangeBoxVisibility() {
      if (!paymentMethodSelectEl || !changeBoxEl) {
        return;
      }
      changeBoxEl.hidden = paymentMethodSelectEl.value !== "Dinheiro";
    }

    if (paymentMethodSelectEl) {
      paymentMethodSelectEl.addEventListener("change", syncChangeBoxVisibility);
      syncChangeBoxVisibility();
    }

    if (needsChangeCheckboxEl && changeAmountFieldEl) {
      needsChangeCheckboxEl.addEventListener("change", function () {
        changeAmountFieldEl.hidden = !needsChangeCheckboxEl.checked;
      });
    }

    var toggleEditorEl = document.getElementById("toggle-checkout-address-editor");
    if (toggleEditorEl) {
      toggleEditorEl.addEventListener("click", function () {
        state.addressEditorOpen = !state.addressEditorOpen;
        if (!state.addressEditorOpen) {
          state.addingAddress = false;
        }
        render();
      });
    }

    document.querySelectorAll('input[name="checkout-default-address"]').forEach(function (radio) {
      radio.addEventListener("change", function () {
        var profile = getAddressDraft();
        profile.defaultAddressId = radio.value;
        window.appDatabase.saveProfile(profile);
        render();
      });
    });

    var addAddressEl = document.getElementById("add-checkout-address-button");
    if (addAddressEl) {
      addAddressEl.addEventListener("click", function () {
        state.addingAddress = true;
        render();
      });
    }

    var cancelNewAddressEl = document.getElementById("cancel-add-checkout-address-button");
    if (cancelNewAddressEl) {
      cancelNewAddressEl.addEventListener("click", function () {
        state.addingAddress = false;
        render();
      });
    }

    var saveNewAddressEl = document.getElementById("save-new-checkout-address-button");
    if (saveNewAddressEl) {
      saveNewAddressEl.addEventListener("click", function () {
        var streetEl = document.getElementById("new-address-street");
        var numberEl = document.getElementById("new-address-number");
        var districtEl = document.getElementById("new-address-district");
        var cityEl = document.getElementById("new-address-city");
        var zipCodeEl = document.getElementById("new-address-zipcode");
        var profile = getAddressDraft();
        var street = streetEl ? streetEl.value.trim() : "";
        var number = numberEl ? numberEl.value.trim() : "";
        var district = districtEl ? districtEl.value.trim() : "";
        var city = cityEl ? cityEl.value.trim() : "";
        var zipCode = zipCodeEl ? zipCodeEl.value.trim() : "";

        if (!street || !number || !district || !city || !zipCode) {
          return;
        }

        var newAddress = {
          id: "address-" + Date.now(),
          street: street,
          number: number,
          district: district,
          city: city,
          zipCode: zipCode,
          reference: "",
        };

        profile.addresses.push(newAddress);
        profile.defaultAddressId = newAddress.id;
        state.addingAddress = false;
        window.appDatabase.saveProfile(profile);
        render();
      });
    }

    var confirmAddressEl = document.getElementById("confirm-checkout-address-button");
    if (confirmAddressEl) {
      confirmAddressEl.addEventListener("click", function () {
        state.addressEditorOpen = false;
        state.addingAddress = false;
        window.appDatabase.saveProfile(getAddressDraft());
        render();
      });
    }

    var finishOrderEl = document.getElementById("finish-order");
    if (finishOrderEl) {
      finishOrderEl.addEventListener("click", async function () {
        var cart = window.appDatabase.getCartDetailed();
        var messageEl = document.getElementById("cart-message");
        var paymentMethodEl = document.getElementById("payment-method");
        var notesEl = document.getElementById("order-notes");
        var profile = getAddressDraft();
        var currentAddress = window.appDatabase.getCurrentAddress(profile);

        if (cart.subtotal < (cart.minOrder || 0)) {
          messageEl.textContent =
            "O pedido mínimo desta loja e " +
            window.appDatabase.formatMoney(cart.minOrder || 0) +
            ".";
          return;
        }

        if (
          !currentAddress ||
          !currentAddress.street ||
          !currentAddress.number ||
          !currentAddress.district
        ) {
          messageEl.textContent = "Complete rua, número e bairro antes de finalizar o pedido.";
          return;
        }

        if (!currentAddress.city) {
          currentAddress.city = "Morretes";
        }

        if (!cart.isOpen) {
          messageEl.textContent =
            "A loja está ativa, mas fora do horário de funcionamento. Tente novamente no horário informado.";
          return;
        }

        var chosenMethodForChange = paymentMethodEl ? paymentMethodEl.value : "Pix";
        var needsChangeEl = document.getElementById("checkout-needs-change");
        var changeAmountEl = document.getElementById("checkout-change-amount");
        var changeFor = null;

        if (chosenMethodForChange === "Dinheiro" && needsChangeEl && needsChangeEl.checked) {
          var currentTotal = Math.max(
            0,
            cart.subtotal +
              window.appDatabase.getDeliveryFeeForStore(cart.store, currentAddress) -
              (state.coupon ? state.coupon.discount : 0)
          );
          changeFor = Number(changeAmountEl ? changeAmountEl.value : 0) || 0;

          if (changeFor < currentTotal) {
            messageEl.textContent =
              "O troco precisa ser para um valor de pelo menos " +
              window.appDatabase.formatMoney(currentTotal) +
              " (total do pedido).";
            return;
          }
        }

        window.appDatabase.saveProfile(profile);

        messageEl.textContent = "Enviando pedido...";
        finishOrderEl.disabled = true;

        var order;
        try {
          order = await window.appDatabase.placeOrder({
            paymentMethod: paymentMethodEl ? paymentMethodEl.value : "Pix",
            notes: notesEl ? notesEl.value.trim() : "",
            couponCode: state.coupon ? state.coupon.code : "",
            changeFor: changeFor,
          });
        } catch (error) {
          finishOrderEl.disabled = false;
          messageEl.textContent =
            (error && error.message) || "Não foi possível finalizar agora. Tente novamente.";
          return;
        }

        if (!order) {
          finishOrderEl.disabled = false;
          messageEl.textContent =
            "Não foi possível finalizar agora. Confira se a loja continua aberta.";
          return;
        }

        var chosenPaymentMethod = paymentMethodEl ? paymentMethodEl.value : "Pix";
        finishOrderEl.disabled = false;

        if (chosenPaymentMethod === "Pix") {
          startPixPayment(order);
          return;
        }

        if (chosenPaymentMethod === "Cartão (crédito ou débito)") {
          startCardPayment(order);
          return;
        }

        window.location.href = "./orders.html?highlight=" + order.id;
      });
    }
  }

  render();
})();
