(function adminOrderPage() {
  var session = window.appDatabase.getOwnerSession();
  var params = new URLSearchParams(window.location.search);
  var orderId = params.get("id");
  var titleEl = document.getElementById("admin-order-title");
  var contentEl = document.getElementById("admin-order-content");

  if (!session || !session.storeId) {
    window.location.href = "./index.html";
    return;
  }

  // Guarda a última mensagem de erro (estorno ou verificação de
  // pagamento) pra reaplicar depois de um render() - sem isso, o
  // refresh automático (a cada 15s, ou assim que o servidor avisa por
  // WebSocket que o pedido mudou) reconstrói a tela inteira e apaga a
  // mensagem antes da pessoa conseguir ler o motivo real do erro.
  var pendingActionMessage = null;

  function applyPendingActionMessage() {
    if (!pendingActionMessage) {
      return;
    }
    var el = document.getElementById(pendingActionMessage.elementId);
    if (el) {
      el.textContent = pendingActionMessage.text;
      el.dataset.state = pendingActionMessage.state || "error";
    }
  }

  function paymentStatusSuffix(order) {
    if (order.paymentStatus === "pago") {
      return " (Pago)";
    }
    if (order.paymentStatus === "pendente") {
      return " (Aguardando pagamento)";
    }
    if (order.paymentStatus === "recusado") {
      return " (Pagamento recusado)";
    }
    if (order.paymentStatus === "estornado") {
      return " (Estornado)";
    }
    return "";
  }

  function changeForSuffix(order) {
    if (order.paymentMethod === "Dinheiro" && order.changeFor) {
      return " · Troco para " + window.appDatabase.formatMoney(order.changeFor);
    }
    return "";
  }

  // Verdadeiro quando o pedido tem um pagamento online já confirmado que
  // ainda não voltou pro cliente - não importa o status do pedido nem
  // quando foi feito. Cobre tanto o pedido cancelado cujo estorno
  // automático falhou quanto um pedido já entregue onde apareceu um
  // problema comprovado depois (o estorno continua disponível mais tarde,
  // não só na hora do cancelamento).
  function orderHasRefundablePayment(order) {
    return order.paymentStatus === "pago" && order.paymentProvider === "mercadopago";
  }

  // Verdadeiro quando o pedido tem uma cobrança do Mercado Pago que ainda
  // não foi confirmada no sistema (nem paga, nem recusada de vez) - se o
  // cliente já pagou de verdade mas o aviso automático (webhook) não
  // chegou por algum motivo, dá pra consultar o status real aqui.
  function orderHasPendingOnlinePayment(order) {
    return (
      order.paymentProvider === "mercadopago" &&
      (order.paymentStatus === "pendente" || order.paymentStatus === "recusado")
    );
  }

  function renderPaymentSyncBlock(order) {
    if (!orderHasPendingOnlinePayment(order)) {
      return "";
    }

    return (
      '<div class="muted-copy">O pagamento online desse pedido ainda consta como "' +
      (order.paymentStatus === "recusado" ? "recusado" : "aguardando pagamento") +
      '" no sistema. Se o cliente já pagou de verdade, toque abaixo pra consultar o status atualizado direto no Mercado Pago.</div>' +
      '<div class="checkout-actions">' +
      '<button class="secondary-button" type="button" id="sync-payment-button">Verificar pagamento agora</button>' +
      "</div>" +
      '<div class="inline-message" id="admin-order-sync-message"></div>'
    );
  }

  function getOrder() {
    var order = window.appDatabase.getOrderById(orderId);

    if (!order || order.storeId !== session.storeId) {
      return null;
    }

    return order;
  }

  function renderActionButtons(order) {
    if (order.status === "Novo") {
      return (
        '<div class="status-actions">' +
        '<button class="primary-button order-status-button" type="button" data-status="Recebido">Aceitar</button>' +
        '<button class="secondary-button order-status-button" type="button" data-status="Cancelado">Recusar</button>' +
        "</div>"
      );
    }

    if (orderHasRefundablePayment(order)) {
      var refundHint =
        order.status === "Cancelado"
          ? "Pedido cancelado, mas o pagamento online ainda não foi estornado."
          : "Esse pedido tem um pagamento online que ainda não foi devolvido. Se ficou comprovado algum problema (mesmo depois da entrega), dá pra estornar por aqui a qualquer momento.";

      return (
        '<div class="muted-copy">' + refundHint + "</div>" +
        '<div class="checkout-actions">' +
        '<button class="secondary-button danger-button" type="button" id="refund-retry-button">Estornar pagamento</button>' +
        "</div>"
      );
    }

    if (order.status === "Cancelado" || order.status === "Entregue") {
      return '<div class="muted-copy">Esse pedido não possui mais ações disponíveis.</div>';
    }

    return (
      '<div class="status-actions">' +
      '<button class="secondary-button order-status-button" type="button" data-status="Recebido">Recebido</button>' +
      '<button class="secondary-button order-status-button" type="button" data-status="Em preparo">Em preparo</button>' +
      '<button class="secondary-button order-status-button" type="button" data-status="Saiu para entrega">Saiu</button>' +
      '<button class="secondary-button order-status-button" type="button" data-status="Entregue">Entregue</button>' +
      "</div>"
    );
  }

  function getWhatsappUrl(phone) {
    var digits = String(phone || "").replace(/\D/g, "");

    if (!digits) {
      return "";
    }

    if (digits.length === 10 || digits.length === 11) {
      digits = "55" + digits;
    }

    return "https://wa.me/" + digits;
  }

  function getDiscountValue(order) {
    var subtotal = Number(order && order.subtotal ? order.subtotal : 0);
    var deliveryFee = Number(order && order.deliveryFee ? order.deliveryFee : 0);
    var total = Number(order && order.total ? order.total : 0);
    var discount = subtotal + deliveryFee - total;

    return discount > 0 ? discount : 0;
  }

  function render() {
    var order = getOrder();
    var whatsappUrl = getWhatsappUrl(order && order.customerPhone);
    var discountValue = getDiscountValue(order);
    var escapeHtml = window.appDatabase.escapeHtml;

    if (!order) {
      titleEl.textContent = "Pedido";
      contentEl.innerHTML =
        '<div class="empty-state">Pedido não encontrado para este estabelecimento.</div>';
      return;
    }

    titleEl.textContent = order.id;

    contentEl.innerHTML =
      '<div class="section-header">' +
      "<h2>" +
      escapeHtml(order.customerName || "Cliente") +
      "</h2>" +
      '<div class="status-pill ' +
      (order.status === "Novo" ? "status-pill-strong" : "") +
      '">' +
      escapeHtml(order.status) +
      "</div>" +
      "</div>" +
      '<div class="checkout-actions admin-order-top-actions">' +
      (whatsappUrl
        ? '<a class="secondary-button" href="' +
          whatsappUrl +
          '" target="_blank" rel="noreferrer">Chamar no WhatsApp</a>'
        : '<button class="secondary-button" type="button" disabled>WhatsApp indisponível</button>') +
      '<button class="secondary-button" type="button" id="print-order-button">Imprimir pedido</button>' +
      "</div>" +
      '<div class="admin-order-detail-grid">' +
      '<div class="admin-order-detail-card">' +
      '<span class="admin-order-label">Pedido</span>' +
      "<strong>" +
      escapeHtml(order.id) +
      "</strong>" +
      "<span>" +
      new Date(order.createdAt).toLocaleString("pt-BR") +
      "</span>" +
      "</div>" +
      '<div class="admin-order-detail-card">' +
      '<span class="admin-order-label">Telefone</span>' +
      "<strong>" +
      escapeHtml(order.customerPhone || "Não informado") +
      "</strong>" +
      "</div>" +
      '<div class="admin-order-detail-card">' +
      '<span class="admin-order-label">Pagamento</span>' +
      "<strong>" +
      escapeHtml(order.paymentMethod) +
      escapeHtml(paymentStatusSuffix(order)) +
      escapeHtml(changeForSuffix(order)) +
      "</strong>" +
      "</div>" +
      '<div class="admin-order-detail-card">' +
      '<span class="admin-order-label">Total</span>' +
      "<strong>" +
      window.appDatabase.formatMoney(order.total) +
      "</strong>" +
      "</div>" +
      '<div class="admin-order-detail-card">' +
      '<span class="admin-order-label">Preparo</span>' +
      "<strong>" +
      escapeHtml(order.prepEstimate || "Sem previsão") +
      "</strong>" +
      "</div>" +
      "</div>" +
      '<div class="admin-order-items admin-order-detail-section">' +
      '<strong class="admin-order-section-title">Itens do pedido</strong>' +
      "<ul>" +
      order.items
        .map(function (item) {
          return (
            "<li>" +
            item.quantity +
            "x " +
            escapeHtml(item.name) +
            " - " +
            window.appDatabase.formatMoney(item.price * item.quantity) +
            "</li>"
          );
        })
        .join("") +
      "</ul>" +
      "</div>" +
      '<div class="admin-order-detail-grid">' +
      '<div class="admin-order-detail-card admin-order-detail-card-wide">' +
      '<span class="admin-order-label">Endereço</span>' +
      "<strong>" +
      escapeHtml(order.address) +
      "</strong>" +
      "</div>" +
      '<div class="admin-order-detail-card admin-order-detail-card-wide">' +
      '<span class="admin-order-label">Observações</span>' +
      "<strong>" +
      escapeHtml(order.notes || "Sem observações") +
      "</strong>" +
      "</div>" +
      "</div>" +
      '<div class="admin-order-actions-group admin-order-detail-section">' +
      '<span class="admin-order-label">Tempo estimado</span>' +
      '<div class="prep-actions admin-order-prep">' +
      '<button class="secondary-button prep-time-button" type="button" data-prep="15 min">15 min</button>' +
      '<button class="secondary-button prep-time-button" type="button" data-prep="30 min">30 min</button>' +
      '<button class="secondary-button prep-time-button" type="button" data-prep="45 min">45 min</button>' +
      '<button class="secondary-button prep-time-button" type="button" data-prep="60 min">60 min</button>' +
      "</div>" +
      "</div>" +
      '<div class="admin-order-actions-group admin-order-detail-section">' +
      '<span class="admin-order-label">Atualizar status</span>' +
      renderActionButtons(order) +
      '<div class="inline-message" id="admin-order-refund-message"></div>' +
      renderPaymentSyncBlock(order) +
      "</div>" +
      '<section class="print-receipt" aria-hidden="true">' +
      '<div class="print-receipt-head">' +
      "<h1>Alloo</h1>" +
      '<span class="print-receipt-subtitle">Comprovante do pedido</span>' +
      '<strong class="print-receipt-order-id">' +
      escapeHtml(order.id) +
      "</strong>" +
      "</div>" +
      '<div class="print-receipt-block">' +
      '<div class="print-receipt-meta">' +
      "<span>Data</span>" +
      "<strong>" +
      new Date(order.createdAt).toLocaleString("pt-BR") +
      "</strong>" +
      "</div>" +
      '<div class="print-receipt-meta">' +
      "<span>Status</span>" +
      "<strong>" +
      escapeHtml(order.status) +
      "</strong>" +
      "</div>" +
      "</div>" +
      '<div class="print-receipt-block">' +
      '<strong class="print-receipt-section-title">Cliente</strong>' +
      '<div class="print-receipt-meta">' +
      "<span>Nome</span>" +
      "<strong>" +
      escapeHtml(order.customerName || "Cliente") +
      "</strong>" +
      "</div>" +
      '<div class="print-receipt-meta">' +
      "<span>Telefone</span>" +
      "<strong>" +
      escapeHtml(order.customerPhone || "Não informado") +
      "</strong>" +
      "</div>" +
      '<div class="print-receipt-meta">' +
      "<span>Endereço</span>" +
      "<strong>" +
      escapeHtml(order.address) +
      "</strong>" +
      "</div>" +
      "</div>" +
      '<div class="print-receipt-block">' +
      '<strong class="print-receipt-section-title">Itens comprados</strong>' +
      '<div class="print-receipt-lines">' +
      order.items
        .map(function (item) {
          return (
            '<div class="print-receipt-line">' +
            '<span class="print-receipt-item-name">' +
            item.quantity +
            "x " +
            escapeHtml(item.name) +
            " (" +
            window.appDatabase.formatMoney(item.price) +
            ' cada)</span>' +
            '<strong class="print-receipt-item-total">' +
            window.appDatabase.formatMoney(item.price * item.quantity) +
            "</strong>" +
            "</div>"
          );
        })
        .join("") +
      "</div>" +
      "</div>" +
      '<div class="print-receipt-block">' +
      '<strong class="print-receipt-section-title">Extrato detalhado</strong>' +
      '<div class="print-receipt-lines">' +
      '<div class="print-receipt-line"><span>Itens</span><strong>' +
      window.appDatabase.formatMoney(order.subtotal || 0) +
      "</strong></div>" +
      '<div class="print-receipt-line"><span>Entrega</span><strong>' +
      window.appDatabase.formatMoney(order.deliveryFee || 0) +
      "</strong></div>" +
      (discountValue
        ? '<div class="print-receipt-line"><span>Desconto</span><strong>-' +
          window.appDatabase.formatMoney(discountValue) +
          "</strong></div>"
        : "") +
      '<div class="print-receipt-line print-receipt-line-total"><span>Total</span><strong>' +
      window.appDatabase.formatMoney(order.total || 0) +
      "</strong></div>" +
      "</div>" +
      "</div>" +
      '<div class="print-receipt-block">' +
      '<strong class="print-receipt-section-title">Fechamento</strong>' +
      '<div class="print-receipt-meta">' +
      "<span>Pagamento</span>" +
      "<strong>" +
      escapeHtml(order.paymentMethod) +
      escapeHtml(paymentStatusSuffix(order)) +
      escapeHtml(changeForSuffix(order)) +
      "</strong>" +
      "</div>" +
      '<div class="print-receipt-meta">' +
      "<span>Observações</span>" +
      "<strong>" +
      escapeHtml(order.notes || "Sem observações") +
      "</strong>" +
      "</div>" +
      "</div>";

    applyPendingActionMessage();
  }

  contentEl.addEventListener("click", async function (event) {
    var statusButton = event.target.closest(".order-status-button");
    if (statusButton) {
      statusButton.disabled = true;
      try {
        var result = await window.appDatabase.updateOrderStatus(orderId, statusButton.dataset.status);
        if (result && result.refund && result.refund.attempted && !result.refund.success) {
          window.alert(
            "Pedido cancelado, mas o estorno automático falhou (" +
              (result.refund.reason || "erro desconhecido") +
              "). Você pode tentar de novo logo abaixo, ou devolver manualmente pelo Mercado Pago."
          );
        }
      } catch (error) {
        console.error(error);
      }
      render();
      return;
    }

    var refundRetryButton = event.target.closest("#refund-retry-button");
    if (refundRetryButton) {
      refundRetryButton.disabled = true;
      pendingActionMessage = null;
      var refundMessageEl = document.getElementById("admin-order-refund-message");
      if (refundMessageEl) {
        refundMessageEl.textContent = "Estornando...";
      }

      var refundResult = await window.appDatabase.refundOrder(orderId);

      if (refundResult && refundResult.error) {
        refundRetryButton.disabled = false;
        pendingActionMessage = {
          elementId: "admin-order-refund-message",
          text: refundResult.error,
          state: "error"
        };
        if (refundMessageEl) {
          refundMessageEl.textContent = refundResult.error;
        }
        return;
      }

      render();
      return;
    }

    var syncPaymentButton = event.target.closest("#sync-payment-button");
    if (syncPaymentButton) {
      syncPaymentButton.disabled = true;
      pendingActionMessage = null;
      var syncMessageEl = document.getElementById("admin-order-sync-message");
      if (syncMessageEl) {
        syncMessageEl.textContent = "Consultando no Mercado Pago...";
        delete syncMessageEl.dataset.state;
      }

      var syncResult = await window.appDatabase.syncOrderPayment(orderId);

      if (syncResult && syncResult.error) {
        syncPaymentButton.disabled = false;
        pendingActionMessage = {
          elementId: "admin-order-sync-message",
          text: syncResult.error,
          state: "error"
        };
        if (syncMessageEl) {
          syncMessageEl.textContent = syncResult.error;
          syncMessageEl.dataset.state = "error";
        }
        return;
      }

      if (syncResult.paymentStatus === "pago") {
        window.alert("Pagamento confirmado! O pedido já aparece como pago.");
      } else if (syncResult.paymentStatus === "pendente") {
        window.alert("O Mercado Pago ainda mostra esse pagamento como pendente - o cliente pode não ter pago ainda.");
      } else if (syncResult.paymentStatus === "recusado") {
        window.alert("O Mercado Pago mostra esse pagamento como recusado.");
      }

      render();
      return;
    }

    var prepButton = event.target.closest(".prep-time-button");
    if (prepButton) {
      prepButton.disabled = true;
      try {
        await window.appDatabase.updateOrderPrepEstimate(orderId, prepButton.dataset.prep);
      } catch (error) {
        console.error(error);
      }
      render();
      return;
    }

    var printButton = event.target.closest("#print-order-button");
    if (printButton) {
      window.print();
    }
  });

  function refreshAndRender() {
    window.appDatabase.syncOwnerOrdersFromServer(session.storeId).finally(render);
  }

  window.addEventListener("storage", render);
  window.setInterval(refreshAndRender, 15000);
  window.appDatabase.connectOwnerOrdersSocket(refreshAndRender);
  render();
  refreshAndRender();
})();