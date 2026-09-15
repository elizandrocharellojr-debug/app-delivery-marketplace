(function ordersPage() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  var params = new URLSearchParams(window.location.search);
  var highlightedOrderId = params.get("highlight");
  var ordersListEl = document.getElementById("orders-list");
  var trackingSectionEl = document.getElementById("tracking-hero-section");
  var trackingStatusLabelEl = document.getElementById("tracking-status-label");
  var trackingEtaPillEl = document.getElementById("tracking-eta-pill");
  var trackingTimelineEl = document.getElementById("tracking-timeline");
  var trackingDeliveryStripEl = document.getElementById("tracking-delivery-strip");
  var ACTIVE_STATUSES = ["Novo", "Recebido", "Em preparo", "Saiu para entrega"];
  var CUSTOMER_CANCELABLE_STATUSES = ["Novo", "Recebido", "Em preparo"];
  var expandedOrderIds = new Set();

  if (highlightedOrderId) {
    expandedOrderIds.add(highlightedOrderId);
  }

  function formatDate(value) {
    return new Date(value).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  var TIMELINE_STEPS = [
    { status: "Recebido", label: "Recebido", icon: "fa-receipt" },
    { status: "Em preparo", label: "Em preparo", icon: "fa-fire" },
    { status: "Saiu para entrega", label: "A caminho", icon: "fa-motorcycle" },
    { status: "Entregue", label: "Entregue", icon: "fa-circle-check" },
  ];

  function getTimelineStepIndex(status) {
    if (status === "Novo") {
      return 1;
    }

    var index = TIMELINE_STEPS.findIndex(function (step) {
      return step.status === status;
    });

    return index >= 0 ? index + 1 : 1;
  }

  function renderCurrentStatus(order) {
    if (order.status === "Cancelado") {
      return (
        '<div class="order-timeline order-timeline-cancelled">' +
        '<span class="order-timeline-dot cancelled"><i class="fas fa-xmark"></i></span>' +
        "<strong>Pedido cancelado</strong>" +
        "</div>"
      );
    }

    var currentIndex = getTimelineStepIndex(order.status);

    return (
      '<div class="order-timeline">' +
      TIMELINE_STEPS.map(function (step, index) {
        var stepPosition = index + 1;
        var isLastStep = stepPosition === TIMELINE_STEPS.length;
        var isCompleted = currentIndex > stepPosition || (isLastStep && currentIndex === stepPosition);
        var isActive = currentIndex === stepPosition && !isCompleted;
        var connector =
          index === 0
            ? ""
            : '<span class="order-timeline-line' + (currentIndex > index ? " completed" : "") + '"></span>';

        return (
          connector +
          '<div class="order-timeline-step' +
          (isCompleted ? " completed" : "") +
          (isActive ? " active" : "") +
          '">' +
          '<span class="order-timeline-dot">' +
          (isCompleted ? '<i class="fas fa-check"></i>' : '<i class="fas ' + step.icon + '"></i>') +
          "</span>" +
          '<span class="order-timeline-label">' +
          step.label +
          "</span>" +
          "</div>"
        );
      }).join("") +
      "</div>"
    );
  }

  function renderVerticalTimeline(order) {
    if (order.status === "Cancelado") {
      return (
        '<div class="order-timeline-vertical-step cancelled">' +
        '<span class="order-timeline-vertical-dot cancelled"><i class="fas fa-xmark"></i></span>' +
        '<span class="order-timeline-vertical-label">Pedido cancelado</span>' +
        "</div>"
      );
    }

    var currentIndex = getTimelineStepIndex(order.status);

    return TIMELINE_STEPS.map(function (step, index) {
      var stepPosition = index + 1;
      var isLastStep = stepPosition === TIMELINE_STEPS.length;
      var isCompleted = currentIndex > stepPosition || (isLastStep && currentIndex === stepPosition);
      var isActive = currentIndex === stepPosition && !isCompleted;

      return (
        '<div class="order-timeline-vertical-step' +
        (isCompleted ? " completed" : "") +
        (isActive ? " active" : "") +
        '">' +
        '<span class="order-timeline-vertical-dot">' +
        (isCompleted ? '<i class="fas fa-check"></i>' : "") +
        "</span>" +
        '<span class="order-timeline-vertical-label">' +
        step.label +
        (isActive ? '<small>' + formatDate(order.updatedAt || order.createdAt) + "</small>" : "") +
        "</span>" +
        "</div>"
      );
    }).join("");
  }

  function renderTrackingHero(orders) {
    var activeOrder = orders.find(function (order) {
      return ACTIVE_STATUSES.indexOf(order.status) >= 0;
    });

    if (!activeOrder) {
      trackingSectionEl.hidden = true;
      return;
    }

    trackingSectionEl.hidden = false;
    trackingStatusLabelEl.textContent = activeOrder.storeName + " · " + activeOrder.status;
    trackingTimelineEl.innerHTML = renderVerticalTimeline(activeOrder);

    if (activeOrder.prepEstimate) {
      trackingEtaPillEl.hidden = false;
      trackingEtaPillEl.textContent = "Chega em ~" + activeOrder.prepEstimate;
    } else {
      trackingEtaPillEl.hidden = true;
    }

    trackingDeliveryStripEl.hidden = activeOrder.status !== "Saiu para entrega";
  }

  function renderStars(rating) {
    var rounded = Math.round(Number(rating) || 0);
    var stars = "";
    for (var i = 1; i <= 5; i += 1) {
      stars +=
        '<button class="review-star-input' +
        (i <= rounded ? " active" : "") +
        '" type="button" data-star="' +
        i +
        '"><i class="fas fa-star"></i></button>';
    }
    return stars;
  }

  function renderReviewBox(order) {
    var reviewedIds = window.appDatabase.getReviewedOrderIds();

    if (order.status !== "Entregue") {
      return "";
    }

    if (reviewedIds.indexOf(order.id) >= 0) {
      return '<div class="order-review-done"><i class="fas fa-star"></i> Você já avaliou este pedido.</div>';
    }

    return (
      '<div class="order-review-box" data-order-id="' +
      order.id +
      '">' +
      "<strong>Como foi seu pedido?</strong>" +
      '<div class="review-star-picker" data-order-id="' +
      order.id +
      '">' +
      renderStars(0) +
      "</div>" +
      '<textarea class="field-textarea review-comment-input" placeholder="Deixe um comentario (opcional)"></textarea>' +
      '<button class="secondary-button small-button review-submit-button" type="button" data-order-id="' +
      order.id +
      '" disabled>Enviar avaliação</button>' +
      '<div class="inline-message review-message"></div>' +
      "</div>"
    );
  }

  // Avaliação por item (ex.: comentário sobre o caimento de uma peça de
  // roupa) - independente da avaliação geral da loja acima, item a item.
  function renderItemReviewBox(order) {
    var escapeHtml = window.appDatabase.escapeHtml;

    if (order.status !== "Entregue" || !order.items.length) {
      return "";
    }

    var reviewedKeys = window.appDatabase.getReviewedItemKeys();

    var itemsHtml = order.items
      .map(function (item) {
        var key = order.id + ":" + item.itemId;

        if (reviewedKeys.indexOf(key) >= 0) {
          return (
            '<div class="item-review-done"><i class="fas fa-star"></i> Você avaliou ' +
            escapeHtml(item.name) +
            ".</div>"
          );
        }

        return (
          '<div class="item-review-box" data-order-id="' +
          order.id +
          '" data-item-id="' +
          item.itemId +
          '">' +
          "<strong>" +
          escapeHtml(item.name) +
          "</strong>" +
          '<div class="review-star-picker item-review-star-picker" data-order-id="' +
          order.id +
          '" data-item-id="' +
          item.itemId +
          '">' +
          renderStars(0) +
          "</div>" +
          '<textarea class="field-textarea item-review-comment-input" placeholder="Comentário sobre este item (opcional)"></textarea>' +
          '<button class="secondary-button small-button item-review-submit-button" type="button" data-order-id="' +
          order.id +
          '" data-item-id="' +
          item.itemId +
          '" disabled>Avaliar item</button>' +
          '<div class="inline-message item-review-message"></div>' +
          "</div>"
        );
      })
      .join("");

    return '<div class="order-item-reviews"><strong>Avalie os itens</strong>' + itemsHtml + "</div>";
  }

  function render() {
    var orders = window.appDatabase.getOrders();
    var escapeHtml = window.appDatabase.escapeHtml;

    renderTrackingHero(orders);

    if (!orders.length) {
      ordersListEl.innerHTML =
        '<div class="empty-state">Você ainda não fez nenhum pedido.</div>';
      return;
    }

    ordersListEl.innerHTML = orders
      .map(function (order) {
        var highlightClass = order.id === highlightedOrderId ? " order-highlight" : "";
        var expandedClass = expandedOrderIds.has(order.id) ? " expanded" : "";
        var statusCopy =
          order.status === "Cancelado"
            ? "O estabelecimento recusou este pedido."
            : order.status === "Entregue"
            ? "Pedido finalizado."
            : "Acompanhe seu pedido em tempo real.";
        var itemCount = order.items.length;

        return (
          '<article class="order-card' +
          highlightClass +
          expandedClass +
          '" data-order-id="' +
          order.id +
          '">' +
          '<button class="order-card-header" type="button" data-order-toggle="' +
          order.id +
          '" aria-expanded="' +
          (expandedOrderIds.has(order.id) ? "true" : "false") +
          '">' +
          '<div class="store-badge">' +
          order.storeIcon +
          "</div>" +
          '<div class="order-card-summary">' +
          "<h3>" +
          escapeHtml(order.storeName) +
          "</h3>" +
          "<span class=\"order-card-subline\">" +
          formatDate(order.createdAt) +
          " · " +
          itemCount +
          (itemCount === 1 ? " item" : " itens") +
          "</span>" +
          "</div>" +
          '<div class="order-card-meta">' +
          '<span class="status-pill">' +
          escapeHtml(order.status) +
          "</span>" +
          "<strong>" +
          window.appDatabase.formatMoney(order.total) +
          "</strong>" +
          "</div>" +
          '<i class="fas fa-chevron-down order-card-chevron" aria-hidden="true"></i>' +
          "</button>" +
          '<div class="order-card-details">' +
          '<div class="checkout-confirm-box">' +
          "<strong>" +
          escapeHtml(order.id) +
          "</strong>" +
          "<span>" +
          statusCopy +
          (order.prepEstimate ? " Previsão de preparo: " + escapeHtml(order.prepEstimate) + "." : "") +
          "</span>" +
          "</div>" +
          renderCurrentStatus(order) +
          '<div class="store-items-preview">' +
          "<strong>Itens</strong>" +
          "<ul>" +
          order.items
            .map(function (item) {
              return "<li>" + item.quantity + "x " + escapeHtml(item.name) + "</li>";
            })
            .join("") +
          "</ul>" +
          "</div>" +
          '<div class="store-info-row">' +
          "<span>" +
          escapeHtml(order.paymentMethod) +
          (order.paymentStatus === "pago"
            ? ' · <strong class="payment-status-paid">Pago</strong>'
            : order.paymentStatus === "pendente"
            ? " · Aguardando pagamento"
            : order.paymentStatus === "recusado"
            ? " · Pagamento recusado"
            : order.paymentStatus === "estornado"
            ? " · Valor estornado"
            : "") +
          (order.paymentMethod === "Dinheiro" && order.changeFor
            ? " · Troco para " + window.appDatabase.formatMoney(order.changeFor)
            : "") +
          "</span>" +
          "<span>" +
          window.appDatabase.formatMoney(order.total) +
          "</span>" +
          "</div>" +
          '<div class="store-info-row">' +
          "<span>" +
          escapeHtml(order.address) +
          "</span>" +
          "<span>Atualizado " +
          formatDate(order.updatedAt || order.createdAt) +
          "</span>" +
          "</div>" +
          (order.notes
            ? '<div class="order-notes"><strong>Observações:</strong><span>' +
              escapeHtml(order.notes) +
              "</span></div>"
            : "") +
          '<div class="checkout-actions">' +
          '<button class="secondary-button small-button reorder-button" type="button" data-order-id="' +
          order.id +
          '">Pedir de novo</button>' +
          (CUSTOMER_CANCELABLE_STATUSES.indexOf(order.status) >= 0
            ? '<button class="secondary-button small-button danger-button cancel-order-button" type="button" data-order-id="' +
              order.id +
              '">Cancelar pedido</button>'
            : "") +
          "</div>" +
          (CUSTOMER_CANCELABLE_STATUSES.indexOf(order.status) >= 0
            ? '<div class="inline-message cancel-order-message" data-order-id="' + order.id + '"></div>'
            : "") +
          renderReviewBox(order) +
          renderItemReviewBox(order) +
          "</div>" +
          "</article>"
        );
      })
      .join("");

    bindOrderCardEvents();
  }

  function bindOrderCardEvents() {
    ordersListEl.querySelectorAll(".order-card-header").forEach(function (headerButton) {
      headerButton.addEventListener("click", function () {
        var orderId = headerButton.dataset.orderToggle;
        var card = headerButton.closest(".order-card");

        if (expandedOrderIds.has(orderId)) {
          expandedOrderIds.delete(orderId);
        } else {
          expandedOrderIds.add(orderId);
        }

        var isExpanded = expandedOrderIds.has(orderId);
        card.classList.toggle("expanded", isExpanded);
        headerButton.setAttribute("aria-expanded", isExpanded ? "true" : "false");
      });
    });

    ordersListEl.querySelectorAll(".reorder-button").forEach(function (button) {
      button.addEventListener("click", function () {
        var order = window.appDatabase.getOrderById(button.dataset.orderId);
        var result = window.appDatabase.buildCartFromOrder(order);

        if (!result.addedCount) {
          button.textContent = "Itens indisponiveis";
          return;
        }

        window.location.href = "./cart.html";
      });
    });

    ordersListEl.querySelectorAll(".cancel-order-button").forEach(function (button) {
      button.addEventListener("click", async function () {
        var orderId = button.dataset.orderId;
        var messageEl = ordersListEl.querySelector('.cancel-order-message[data-order-id="' + orderId + '"]');

        if (!window.confirm("Tem certeza que quer cancelar este pedido? Se já foi pago, o estorno é solicitado automaticamente.")) {
          return;
        }

        button.disabled = true;
        if (messageEl) {
          messageEl.textContent = "Cancelando...";
          messageEl.removeAttribute("data-state");
        }

        var result = await window.appDatabase.cancelOrderByCustomer(orderId);

        if (result && result.error) {
          button.disabled = false;
          if (messageEl) {
            messageEl.textContent = result.error;
            messageEl.dataset.state = "error";
          }
          return;
        }

        if (result && result.refund && result.refund.attempted && !result.refund.success) {
          window.alert(
            "Pedido cancelado. O estorno automático não foi concluído agora (" +
              (result.refund.reason || "erro desconhecido") +
              "), mas a loja foi avisada e pode tentar de novo - o dinheiro será devolvido."
          );
        }

        render();
      });
    });

    ordersListEl.querySelectorAll(".review-star-picker").forEach(function (picker) {
      picker.addEventListener("click", function (event) {
        var starButton = event.target.closest(".review-star-input");
        if (!starButton) {
          return;
        }

        var value = Number(starButton.dataset.star);
        picker.dataset.value = String(value);
        picker.querySelectorAll(".review-star-input").forEach(function (star) {
          star.classList.toggle("active", Number(star.dataset.star) <= value);
        });

        var box = picker.closest(".order-review-box");
        var submitButton = box.querySelector(".review-submit-button");
        submitButton.disabled = value < 1;
      });
    });

    ordersListEl.querySelectorAll(".review-submit-button").forEach(function (button) {
      button.addEventListener("click", async function () {
        var box = button.closest(".order-review-box");
        var picker = box.querySelector(".review-star-picker");
        var commentEl = box.querySelector(".review-comment-input");
        var messageEl = box.querySelector(".review-message");
        var rating = Number(picker.dataset.value || 0);

        if (rating < 1) {
          messageEl.textContent = "Escolha uma nota antes de enviar.";
          return;
        }

        button.disabled = true;
        messageEl.textContent = "Enviando...";

        var result = await window.appDatabase.submitReview(
          button.dataset.orderId,
          rating,
          commentEl.value.trim()
        );

        if (result && result.error) {
          button.disabled = false;
          messageEl.textContent = result.error;
          return;
        }

        window.appDatabase.markOrderReviewed(button.dataset.orderId);
        render();
      });
    });

    ordersListEl.querySelectorAll(".item-review-star-picker").forEach(function (picker) {
      picker.addEventListener("click", function (event) {
        var starButton = event.target.closest(".review-star-input");
        if (!starButton) {
          return;
        }

        var value = Number(starButton.dataset.star);
        picker.dataset.value = String(value);
        picker.querySelectorAll(".review-star-input").forEach(function (star) {
          star.classList.toggle("active", Number(star.dataset.star) <= value);
        });

        var box = picker.closest(".item-review-box");
        var submitButton = box.querySelector(".item-review-submit-button");
        submitButton.disabled = value < 1;
      });
    });

    ordersListEl.querySelectorAll(".item-review-submit-button").forEach(function (button) {
      button.addEventListener("click", async function () {
        var box = button.closest(".item-review-box");
        var picker = box.querySelector(".item-review-star-picker");
        var commentEl = box.querySelector(".item-review-comment-input");
        var messageEl = box.querySelector(".item-review-message");
        var rating = Number(picker.dataset.value || 0);
        var orderId = button.dataset.orderId;
        var itemId = button.dataset.itemId;

        if (rating < 1) {
          messageEl.textContent = "Escolha uma nota antes de enviar.";
          return;
        }

        button.disabled = true;
        messageEl.textContent = "Enviando...";

        var result = await window.appDatabase.submitItemReview(
          orderId,
          itemId,
          rating,
          commentEl.value.trim()
        );

        if (result && result.error) {
          button.disabled = false;
          messageEl.textContent = result.error;
          return;
        }

        window.appDatabase.markItemReviewed(orderId, itemId);
        render();
      });
    });
  }

  function refreshAndRender() {
    window.appDatabase.refreshCustomerOrdersFromServer().finally(render);
  }

  window.addEventListener("storage", render);
  window.setInterval(refreshAndRender, 4000);

  render();
  refreshAndRender();
})();
