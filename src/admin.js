(function adminPage() {
  var session = window.appDatabase.getOwnerSession();

  if (!session || !session.storeId) {
    window.location.href = "./index.html";
    return;
  }

  // -- Referencias de DOM ----------------------------------------------------

  var navItemEls = Array.prototype.slice.call(document.querySelectorAll(".admin-dash-nav-item"));
  var panelTitleEl = document.getElementById("owner-panel-title");
  var panelSubtitleEl = document.getElementById("owner-panel-subtitle");
  var statusToggleEl = document.getElementById("owner-status-toggle");
  var statusSwitchEl = document.getElementById("owner-status-switch");
  var storeStatusEl = document.getElementById("owner-store-status");
  var statusHintEl = document.getElementById("owner-status-hint");
  var logoutButtonEl = document.getElementById("owner-logout-button");
  var impersonationBannerEl = document.getElementById("admin-impersonation-banner");

  if (impersonationBannerEl) {
    impersonationBannerEl.hidden = !session.viaAdmin;
  }

  var kpiRevenueEl = document.getElementById("kpi-revenue-today");
  var kpiOrdersEl = document.getElementById("kpi-orders-today");
  var kpiRatingEl = document.getElementById("kpi-store-rating");

  var searchInputEl = document.getElementById("pedidos-search-input");
  var resetButtonEl = document.getElementById("pedidos-reset-button");
  var activeOrdersBadgeEl = document.getElementById("active-orders-badge");
  var activeOrdersListEl = document.getElementById("admin-active-orders-list");
  var historyBodyEl = document.getElementById("admin-orders-history-body");
  var menuPreviewListEl = document.getElementById("admin-menu-preview-list");
  var menuPreviewAddButtonEl = document.getElementById("menu-preview-add-button");

  var addItemButtonEl = document.getElementById("add-item-button");
  var itemsListEl = document.getElementById("admin-items-list");
  var itemsMessageEl = document.getElementById("admin-items-message");

  var hoursInputEls = Array.prototype.slice.call(document.querySelectorAll(".opening-hours-input"));
  var saveHoursButtonEl = document.getElementById("save-hours-button");
  var hoursMessageEl = document.getElementById("opening-hours-message");

  var couponFormEl = document.getElementById("coupon-form");
  var couponCodeInputEl = document.getElementById("coupon-code-input");
  var couponTypeInputEl = document.getElementById("coupon-type-input");
  var couponValueInputEl = document.getElementById("coupon-value-input");
  var couponMinOrderInputEl = document.getElementById("coupon-min-order-input");
  var couponMaxUsesInputEl = document.getElementById("coupon-max-uses-input");
  var couponExpiresInputEl = document.getElementById("coupon-expires-input");
  var couponMessageEl = document.getElementById("coupon-message");
  var couponsListEl = document.getElementById("coupons-list");

  var metricsContentEl = document.getElementById("metrics-content");

  var reviewsSummaryEl = document.getElementById("reviews-summary");
  var reviewsListEl = document.getElementById("reviews-list");
  var itemReviewsListEl = document.getElementById("item-reviews-list");

  var storeFormEl = document.getElementById("store-form");
  var addDistrictFeeButtonEl = document.getElementById("add-district-fee-button");
  var districtFeesListEl = document.getElementById("district-fees-list");
  var storeMessageEl = document.getElementById("admin-store-message");

  var storeLogoPreviewEl = document.getElementById("store-logo-preview");
  var storeLogoFileInputEl = document.getElementById("store-logo-file-input");
  var storeLogoInputEl = document.getElementById("store-logo-input");

  var ownerEmailFormEl = document.getElementById("owner-email-form");
  var ownerEmailInputEl = document.getElementById("owner-email-input");
  var ownerEmailMessageEl = document.getElementById("owner-email-message");

  var fields = {
    name: document.getElementById("store-name-input"),
    description: document.getElementById("store-description-input"),
    minOrder: document.getElementById("store-min-order-input"),
    isActive: document.getElementById("store-active-input"),
    instagram: document.getElementById("store-instagram-input"),
    facebook: document.getElementById("store-facebook-input"),
    logoUrl: document.getElementById("store-logo-input"),
  };

  var WEEK_DAYS = [
    { key: "segunda", label: "Segunda" },
    { key: "terca", label: "Terca" },
    { key: "quarta", label: "Quarta" },
    { key: "quinta", label: "Quinta" },
    { key: "sexta", label: "Sexta" },
    { key: "sabado", label: "Sabado" },
    { key: "domingo", label: "Domingo" },
  ];

  var SECTION_TITLES = {
    pedidos: "Pedidos",
    cardapio: "Cardápio",
    horarios: "Horário de funcionamento",
    promocoes: "Promoções",
    financeiro: "Financeiro",
    avaliacoes: "Avaliações",
    configuracoes: "Configurações",
  };

  var loadedSections = {};

  var state = {
    storeId: session.storeId,
    search: "",
    lastNewOrdersCount: 0,
    itemsDraft: [],
    isEditingItems: false,
    highlightedItemIndex: -1,
    activeSection: "pedidos",
  };

  // -- Navegacao por seção ----------------------------------------------------

  function refreshSubtitle() {
    panelSubtitleEl.textContent =
      (SECTION_TITLES[state.activeSection] || "") +
      " · Logado como " +
      (session ? session.ownerName : "Parceiro");
  }

  function switchSection(section) {
    state.activeSection = section;

    navItemEls.forEach(function (item) {
      item.classList.toggle("active", item.dataset.section === section);
    });

    document.querySelectorAll(".admin-dash-section").forEach(function (panel) {
      panel.hidden = panel.id !== "admin-section-" + section;
    });

    refreshSubtitle();

    if (!loadedSections[section]) {
      loadedSections[section] = true;
      if (section === "promocoes") {
        loadAndRenderCoupons();
      }
      if (section === "financeiro") {
        loadAndRenderMetrics();
      }
      if (section === "avaliacoes") {
        loadAndRenderReviews();
      }
    }
  }

  navItemEls.forEach(function (item) {
    item.addEventListener("click", function () {
      switchSection(item.dataset.section);
    });
  });

  if (menuPreviewAddButtonEl) {
    menuPreviewAddButtonEl.addEventListener("click", function () {
      switchSection("cardapio");
      handleAddItem();
    });
  }

  // -- Som de novo pedido -------------------------------------------------

  function playNewOrderSound() {
    try {
      var audioContext =
        window.AudioContext ? new window.AudioContext() : new window.webkitAudioContext();

      if (!audioContext) {
        return;
      }

      function playTone(startAt, frequency, duration) {
        var oscillator = audioContext.createOscillator();
        var gainNode = audioContext.createGain();

        oscillator.type = "square";
        oscillator.frequency.setValueAtTime(frequency, startAt);
        gainNode.gain.setValueAtTime(0.001, startAt);
        gainNode.gain.exponentialRampToValueAtTime(0.62, startAt + 0.02);
        gainNode.gain.exponentialRampToValueAtTime(0.001, startAt + duration);

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + duration);
      }

      var now = audioContext.currentTime;
      playTone(now, 1046, 0.22);
      playTone(now + 0.28, 1318, 0.24);
    } catch (error) {
      // Silently ignore browsers that block autoplay/audio context.
    }
  }

  // -- Status da loja -----------------------------------------------------

  function syncStoreStatusButtons(isActive) {
    var active = isActive !== false;
    fields.isActive.value = active ? "true" : "false";
    storeStatusEl.textContent = active ? "Aberta" : "Fechada";
    statusHintEl.textContent = active ? "Toque para fechar a loja" : "Toque para abrir a loja";
    statusSwitchEl.classList.toggle("is-on", active);
    statusToggleEl.classList.toggle("is-closed", !active);
  }

  statusToggleEl.addEventListener("click", async function () {
    var nextActive = !(fields.isActive.value === "true");
    syncStoreStatusButtons(nextActive);
    statusToggleEl.disabled = true;

    var result = await saveStoreDraft();

    statusToggleEl.disabled = false;

    if (!result) {
      syncStoreStatusButtons(!nextActive);
    }
  });

  logoutButtonEl.addEventListener("click", function () {
    window.appDatabase.clearOwnerSession();
    window.location.href = "./index.html";
  });

  // -- KPIs do topo ---------------------------------------------------------

  function todayKey(date) {
    return (date || new Date()).toISOString().slice(0, 10);
  }

  function updateKpis() {
    var orders = window.appDatabase.getOrdersByStore(state.storeId) || [];
    var today = todayKey();
    var revenueToday = 0;
    var ordersToday = 0;

    orders.forEach(function (order) {
      if (String(order.createdAt || "").slice(0, 10) !== today) {
        return;
      }
      if (order.status === "Cancelado") {
        return;
      }
      ordersToday += 1;
      revenueToday += Number(order.total || 0);
    });

    kpiRevenueEl.textContent = window.appDatabase.formatMoney(revenueToday);
    kpiOrdersEl.textContent = String(ordersToday);

    var currentStore = getCurrentStore();
    if (currentStore && currentStore.avgRating != null) {
      kpiRatingEl.textContent = "★ " + currentStore.avgRating.toFixed(1);
    } else {
      kpiRatingEl.textContent = "Sem avaliações";
    }
  }

  // -- Pedidos --------------------------------------------------------------

  var ACTIVE_STATUSES = ["Novo", "Recebido", "Em preparo", "Saiu para entrega"];

  function normalizeSearch(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim();
  }

  function compareOrdersDesc(a, b) {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  }

  function elapsedInfo(order) {
    var minutes = Math.max(0, Math.round((Date.now() - new Date(order.createdAt).getTime()) / 60000));
    var label = minutes < 1 ? "agora" : minutes + " min";
    var cls = "elapsed-ok";

    if (order.status !== "Entregue" && order.status !== "Cancelado") {
      if (minutes >= 20) {
        cls = "elapsed-late";
      } else if (minutes >= 10) {
        cls = "elapsed-warn";
      }
    }

    return { label: label, cls: cls };
  }

  function getNextStep(status) {
    if (status === "Recebido") {
      return { status: "Em preparo", label: "Iniciar preparo" };
    }
    if (status === "Em preparo") {
      return { status: "Saiu para entrega", label: "Saiu para entrega" };
    }
    if (status === "Saiu para entrega") {
      return { status: "Entregue", label: "Marcar como entregue" };
    }
    return null;
  }

  function renderCardActions(order) {
    if (order.status === "Novo") {
      return (
        '<div class="pedidos-card-actions">' +
        '<button class="primary-button pedidos-action-button" type="button" data-order-id="' +
        order.id +
        '" data-next-status="Recebido">Aceitar</button>' +
        '<button class="secondary-button danger-button pedidos-action-button" type="button" data-order-id="' +
        order.id +
        '" data-next-status="Cancelado">Recusar</button>' +
        "</div>"
      );
    }

    var next = getNextStep(order.status);

    if (next) {
      return (
        '<div class="pedidos-card-actions">' +
        '<button class="secondary-button pedidos-action-button" type="button" data-order-id="' +
        order.id +
        '" data-next-status="' +
        next.status +
        '">' +
        next.label +
        "</button>" +
        "</div>"
      );
    }

    return "";
  }

  function renderOrderCard(order) {
    var escapeHtml = window.appDatabase.escapeHtml;
    var elapsed = elapsedInfo(order);
    var itemCount = (order.items || []).length;

    return (
      '<div class="pedidos-card" data-order-id="' +
      order.id +
      '">' +
      '<div class="pedidos-card-top">' +
      "<div>" +
      '<strong class="pedidos-card-customer">' +
      escapeHtml(order.customerName || "Cliente") +
      "</strong>" +
      '<div class="pedidos-card-meta">' +
      itemCount +
      (itemCount === 1 ? " item" : " itens") +
      "</div>" +
      (order.changeFor
        ? '<div class="pedidos-card-change-badge"><i class="fas fa-money-bill-wave"></i> Troco para ' +
          window.appDatabase.formatMoney(order.changeFor) +
          "</div>"
        : "") +
      "</div>" +
      '<span class="pedidos-card-elapsed ' +
      elapsed.cls +
      '">' +
      elapsed.label +
      "</span>" +
      "</div>" +
      '<div class="pedidos-card-bottom">' +
      '<span class="pedidos-card-total">' +
      window.appDatabase.formatMoney(order.total) +
      "</span>" +
      '<span class="status-pill">' +
      escapeHtml(order.status) +
      "</span>" +
      "</div>" +
      renderCardActions(order) +
      "</div>"
    );
  }

  function renderOrders() {
    var orders = window.appDatabase.getOrdersByStore(state.storeId) || [];
    var searchTerm = normalizeSearch(state.search);
    var newOrdersCount = window.appDatabase.getNewOrdersCountByStore(state.storeId);

    if (newOrdersCount > state.lastNewOrdersCount) {
      playNewOrderSound();
    }
    state.lastNewOrdersCount = newOrdersCount;

    if (searchTerm) {
      orders = orders.filter(function (order) {
        var orderId = normalizeSearch(order.id);
        var customerName = normalizeSearch(order.customerName || "Cliente");
        return orderId.indexOf(searchTerm) !== -1 || customerName.indexOf(searchTerm) !== -1;
      });
    }

    var active = orders
      .filter(function (order) {
        return ACTIVE_STATUSES.indexOf(order.status) !== -1;
      })
      .sort(compareOrdersDesc);

    var history = orders
      .filter(function (order) {
        return ACTIVE_STATUSES.indexOf(order.status) === -1;
      })
      .sort(compareOrdersDesc)
      .slice(0, 300);

    activeOrdersBadgeEl.textContent = String(active.length);

    if (!active.length) {
      activeOrdersListEl.innerHTML =
        '<div class="admin-dash-empty-hint">' +
        (searchTerm ? "Nenhum pedido encontrado." : "Nenhum pedido em andamento no momento.") +
        "</div>";
    } else {
      activeOrdersListEl.innerHTML = active.map(renderOrderCard).join("");
    }

    if (!history.length) {
      historyBodyEl.innerHTML =
        '<tr><td colspan="5" class="admin-dash-empty-hint">Nenhum pedido no histórico ainda.</td></tr>';
    } else {
      historyBodyEl.innerHTML = history
        .map(function (order) {
          var escapeHtml = window.appDatabase.escapeHtml;
          return (
            '<tr class="admin-dash-table-row-clickable" data-order-id="' +
            escapeHtml(order.id) +
            '" title="Abrir pedido">' +
            "<td>#" +
            String(order.id).replace("PED-", "").slice(-6) +
            "</td>" +
            "<td>" +
            escapeHtml(order.customerName || "Cliente") +
            "</td>" +
            '<td class="is-money">' +
            window.appDatabase.formatMoney(order.total) +
            "</td>" +
            '<td><span class="status-pill">' +
            escapeHtml(order.status) +
            "</span></td>" +
            "<td>" +
            new Date(order.createdAt).toLocaleString("pt-BR") +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
    }

    updateKpis();
  }

  if (activeOrdersListEl) {
    activeOrdersListEl.addEventListener("click", async function (event) {
      var actionButton = event.target.closest(".pedidos-action-button");

      if (actionButton) {
        actionButton.disabled = true;
        try {
          var result = await window.appDatabase.updateOrderStatus(
            actionButton.dataset.orderId,
            actionButton.dataset.nextStatus
          );
          if (result && result.refund && result.refund.attempted && !result.refund.success) {
            window.alert(
              "Pedido cancelado, mas o estorno automático falhou (" +
                (result.refund.reason || "erro desconhecido") +
                "). Abra o pedido pra tentar estornar de novo, ou devolva manualmente pelo Mercado Pago."
            );
          }
        } catch (error) {
          console.error(error);
        }
        renderOrders();
        return;
      }

      var card = event.target.closest(".pedidos-card");
      if (card) {
        window.location.href = "./admin-order.html?id=" + encodeURIComponent(card.dataset.orderId);
      }
    });
  }

  if (historyBodyEl) {
    historyBodyEl.addEventListener("click", function (event) {
      var row = event.target.closest("tr[data-order-id]");
      if (row) {
        window.location.href = "./admin-order.html?id=" + encodeURIComponent(row.dataset.orderId);
      }
    });
  }

  if (searchInputEl) {
    searchInputEl.addEventListener("input", function () {
      state.search = searchInputEl.value || "";
      renderOrders();
    });
  }

  if (resetButtonEl) {
    resetButtonEl.addEventListener("click", async function () {
      var confirmed = window.confirm(
        "Isso vai apagar todo o histórico de pedidos desta loja (novos, em preparo, entregues e cancelados). Essa ação não pode ser desfeita.\n\nTem certeza que deseja continuar?"
      );

      if (!confirmed) {
        return;
      }

      resetButtonEl.disabled = true;
      try {
        await window.appDatabase.clearOrdersByStore(state.storeId);
      } catch (error) {
        console.error(error);
      }
      resetButtonEl.disabled = false;
      renderOrders();
    });
  }

  function startAutoRefresh() {
    window.setInterval(function () {
      window.appDatabase.syncOwnerOrdersFromServer(state.storeId).finally(renderOrders);
    }, 15000);

    window.appDatabase.connectOwnerOrdersSocket(function () {
      window.appDatabase.syncOwnerOrdersFromServer(state.storeId).finally(renderOrders);
    });
  }

  window.addEventListener("storage", renderOrders);

  // -- Cardapio (editor completo) ---------------------------------------------

  function renderItems(items, forceRender) {
    if (state.isEditingItems && !forceRender) {
      return;
    }

    itemsListEl.innerHTML = "";

    items.forEach(function (item, index) {
      itemsListEl.appendChild(createItemCardElement(item, index));
    });

    bindItemEvents();
    renderMenuPreview(items);
  }

  function renderMenuPreview(items) {
    if (!menuPreviewListEl) {
      return;
    }

    if (!items.length) {
      menuPreviewListEl.innerHTML = '<div class="admin-dash-empty-hint">Nenhum item cadastrado ainda.</div>';
      return;
    }

    var escapeHtml = window.appDatabase.escapeHtml;

    menuPreviewListEl.innerHTML = items
      .map(function (item) {
        var photo = item.photoUrl
          ? '<img src="' + item.photoUrl + '" alt="" />'
          : "foto";
        return (
          '<div class="admin-dash-menu-preview-item">' +
          '<div class="admin-dash-menu-preview-photo">' +
          photo +
          "</div>" +
          '<div class="admin-dash-menu-preview-info">' +
          "<strong>" +
          escapeHtml(item.name || "Sem nome") +
          "</strong>" +
          "<span>" +
          window.appDatabase.formatMoney(Number(item.price || 0)) +
          "</span>" +
          "</div>" +
          '<span class="status-pill">' +
          (item.available !== false ? "Ativo" : "Pausado") +
          "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function createLabeledInput(label, inputClass, type, value, placeholder, extraAttributes) {
    var field = document.createElement("label");
    field.className = "field item-inline-field";

    var span = document.createElement("span");
    span.textContent = label;

    var input = document.createElement("input");
    input.className = inputClass;
    input.type = type;
    input.value = value;
    input.placeholder = placeholder;

    if (extraAttributes) {
      Object.keys(extraAttributes).forEach(function (key) {
        input.setAttribute(key, extraAttributes[key]);
      });
    }

    field.appendChild(span);
    field.appendChild(input);
    return field;
  }

  function createItemPhotoField(item) {
    var field = document.createElement("label");
    field.className = "field item-inline-field item-photo-field item-description-field";

    var span = document.createElement("span");
    span.textContent = "Foto do item";

    var preview = document.createElement("div");
    preview.className = "item-photo-preview";
    preview.innerHTML = item.photoUrl
      ? '<img class="item-photo-preview-image" src="' + item.photoUrl + '" alt="Foto do item" />'
      : '<div class="item-photo-preview-empty">Sem foto</div>';

    var input = document.createElement("input");
    input.className = "item-photo-file-input";
    input.type = "file";
    input.accept = "image/*";

    var hiddenInput = document.createElement("input");
    hiddenInput.className = "item-photo-input";
    hiddenInput.type = "hidden";
    hiddenInput.value = item.photoUrl || "";

    var helper = document.createElement("small");
    helper.className = "item-photo-helper";
    helper.textContent = "Escolha uma imagem do computador para este item.";

    field.appendChild(span);
    field.appendChild(preview);
    field.appendChild(input);
    field.appendChild(hiddenInput);
    field.appendChild(helper);
    return field;
  }

  function createItemCardElement(item, index) {
    var article = document.createElement("article");
    article.className =
      "item-editor-card" + (state.highlightedItemIndex === index ? " item-editor-card-highlight" : "");
    article.dataset.index = String(index);
    article.dataset.itemId = item.id || "";

    var top = document.createElement("div");
    top.className = "item-editor-card-top";

    var titleGroup = document.createElement("div");
    titleGroup.className = "item-editor-card-title-group";

    var title = document.createElement("strong");
    title.textContent = "Item " + (index + 1);

    var toggle = document.createElement("label");
    toggle.className = "item-toggle item-toggle-card item-toggle-card-inline";

    var toggleInput = document.createElement("input");
    toggleInput.className = "item-available-input";
    toggleInput.type = "checkbox";
    toggleInput.checked = item.available !== false;

    var toggleSwitch = document.createElement("span");
    toggleSwitch.className = "item-toggle-switch";
    toggleSwitch.setAttribute("aria-hidden", "true");

    var toggleLabel = document.createElement("span");
    toggleLabel.className = "item-toggle-label";
    toggleLabel.textContent = "Disponível";

    toggle.appendChild(toggleInput);
    toggle.appendChild(toggleSwitch);
    toggle.appendChild(toggleLabel);

    var removeButton = document.createElement("button");
    removeButton.className = "qty-btn remove-item-button";
    removeButton.type = "button";
    removeButton.setAttribute("aria-label", "Remover item");
    removeButton.textContent = "x";
    removeButton.onclick = function (event) {
      event.preventDefault();
      event.stopPropagation();
      removeItemCard(article);
    };

    titleGroup.appendChild(title);
    titleGroup.appendChild(toggle);
    top.appendChild(titleGroup);
    top.appendChild(removeButton);

    var row = document.createElement("div");
    row.className = "item-editor-row";
    row.dataset.index = String(index);

    row.appendChild(
      createLabeledInput("Nome do item", "item-name-input", "text", item.name || "", "Ex.: X-Burguer especial")
    );
    row.appendChild(
      createLabeledInput("Preço", "item-price-input", "number", String(item.price || 0), "0,00", { step: "0.01" })
    );
    row.appendChild(
      createLabeledInput(
        "Preço promocional",
        "item-promo-price-input",
        "number",
        item.promoPrice != null ? String(item.promoPrice) : "",
        "Opcional",
        { step: "0.01" }
      )
    );
    row.appendChild(
      createLabeledInput("Categoria", "item-section-input", "text", item.section || "Geral", "Ex.: Lanches")
    );

    var descriptionField = createLabeledInput(
      "Descrição curta",
      "item-description-input",
      "text",
      item.description || "",
      "Ex.: Pao, carne, queijo e molho da casa"
    );
    descriptionField.classList.add("item-description-field");
    row.appendChild(descriptionField);

    var photoField = createItemPhotoField(item);
    row.appendChild(photoField);

    var actions = document.createElement("div");
    actions.className = "item-editor-actions";

    var saveButton = document.createElement("button");
    saveButton.className = "primary-button save-item-button";
    saveButton.type = "button";
    saveButton.textContent = "Salvar item";
    saveButton.onclick = function (event) {
      event.preventDefault();
      event.stopPropagation();
      persistSingleItem(article);
    };
    actions.appendChild(saveButton);

    article.appendChild(top);
    article.appendChild(row);
    article.appendChild(actions);
    setItemSaveVisible(article, false);
    return article;
  }

  function setItemSaveVisible(card, visible) {
    if (!card) {
      return;
    }
    card.classList.toggle("item-editor-card-dirty", !!visible);
  }

  function buildEmptyItem() {
    return {
      id: "",
      name: "",
      price: 0,
      promoPrice: null,
      section: "Geral",
      description: "",
      photoUrl: "",
      available: true,
    };
  }

  function handleAddItem() {
    var newIndex;
    var newCard;
    var lastNameInput;

    if (!itemsListEl) {
      itemsMessageEl.textContent = "Não foi possível localizar a lista de itens.";
      return;
    }

    newIndex = itemsListEl.querySelectorAll(".item-editor-card").length;
    state.highlightedItemIndex = newIndex;
    newCard = createItemCardElement(buildEmptyItem(), newIndex);

    itemsListEl.appendChild(newCard);
    bindItemEvents();
    state.isEditingItems = true;
    itemsMessageEl.textContent = "Novo item criado. Preencha os dados abaixo.";
    setItemSaveVisible(newCard, true);

    newCard.scrollIntoView({ behavior: "smooth", block: "center" });

    lastNameInput = newCard.querySelector(".item-name-input");
    if (lastNameInput) {
      lastNameInput.focus();
    }

    window.setTimeout(function () {
      state.highlightedItemIndex = -1;
      newCard.classList.remove("item-editor-card-highlight");
    }, 1600);
  }

  window.adminAddItem = handleAddItem;

  function removeItemCard(card) {
    var index;

    if (!card) {
      return;
    }

    state.isEditingItems = false;
    syncItemsDraftFromDom();
    index = Array.from(itemsListEl.querySelectorAll(".item-editor-card")).indexOf(card);

    if (index >= 0) {
      state.itemsDraft.splice(index, 1);
    }

    renderItems(state.itemsDraft, true);
    itemsMessageEl.textContent = "Item removido com sucesso.";
    itemsMessageEl.dataset.state = "success";
  }

  function collectItemFromCard(card, index) {
    var existing = state.itemsDraft[index] || {};
    var row = card.querySelector(".item-editor-row");

    if (!row) {
      return null;
    }

    return {
      id: existing.id || "",
      name: row.querySelector(".item-name-input").value.trim(),
      price: Number(row.querySelector(".item-price-input").value || 0),
      promoPrice: row.querySelector(".item-promo-price-input").value
        ? Number(row.querySelector(".item-promo-price-input").value)
        : null,
      section: row.querySelector(".item-section-input").value.trim() || "Geral",
      description: row.querySelector(".item-description-input").value.trim(),
      photoUrl: row.querySelector(".item-photo-input").value.trim(),
      available: card.querySelector(".item-available-input").checked,
    };
  }

  async function persistSingleItem(card) {
    var index;
    var item;
    var savedStore;
    var currentStore;
    var items;
    var existingIndex;
    var row;
    var itemName;
    var reloadedStore;

    if (!card) {
      return;
    }

    itemsMessageEl.textContent = "Salvando item...";
    itemsMessageEl.dataset.state = "";

    if (!state.storeId) {
      itemsMessageEl.textContent = "Salve a loja primeiro para cadastrar itens.";
      itemsMessageEl.dataset.state = "error";
      return;
    }

    try {
      row = card.querySelector(".item-editor-row");
      itemName = row ? row.querySelector(".item-name-input").value.trim() : "";

      if (!itemName) {
        itemsMessageEl.textContent = "Preencha o nome do item antes de salvar.";
        itemsMessageEl.dataset.state = "error";
        return;
      }

      index = Array.from(itemsListEl.querySelectorAll(".item-editor-card")).indexOf(card);
      item = collectItemFromCard(card, index);

      if (!item) {
        itemsMessageEl.textContent = "Não foi possível salvar este item.";
        itemsMessageEl.dataset.state = "error";
        return;
      }

      currentStore = getCurrentStore();

      if (!currentStore) {
        itemsMessageEl.textContent = "Não foi possível localizar a loja.";
        itemsMessageEl.dataset.state = "error";
        return;
      }

      items = (currentStore.items || []).slice();
      existingIndex = -1;

      if (card.dataset.itemId) {
        existingIndex = items.findIndex(function (storeItem) {
          return storeItem.id === card.dataset.itemId;
        });
      }

      if (existingIndex === -1 && index < items.length) {
        existingIndex = index;
      }

      savedStore = window.appDatabase.upsertStoreItem(
        state.storeId,
        item,
        card.dataset.itemId || item.id || "",
        existingIndex
      );
      await window.appDatabase.pushStoreItemToServer(
        state.storeId,
        item,
        card.dataset.itemId || item.id || "",
        existingIndex
      );
      state.isEditingItems = false;
      reloadedStore = window.appDatabase.getStoreById(state.storeId);

      if (savedStore && reloadedStore) {
        fillForm(reloadedStore);
        itemsMessageEl.textContent = "Item salvo com sucesso.";
        itemsMessageEl.dataset.state = "success";
      } else {
        itemsMessageEl.textContent = "Não foi possível salvar este item.";
        itemsMessageEl.dataset.state = "error";
      }
    } catch (error) {
      console.error(error);
      itemsMessageEl.textContent = "Erro ao salvar item.";
      itemsMessageEl.dataset.state = "error";
    }
  }

  function syncItemsDraftFromDom() {
    state.itemsDraft = Array.from(itemsListEl.querySelectorAll(".item-editor-card")).map(function (card, index) {
      var existing = state.itemsDraft[index] || {};
      var row = card.querySelector(".item-editor-row");

      return {
        id: existing.id || "",
        name: row.querySelector(".item-name-input").value,
        price: Number(row.querySelector(".item-price-input").value || 0),
        promoPrice: row.querySelector(".item-promo-price-input").value
          ? Number(row.querySelector(".item-promo-price-input").value)
          : null,
        section: row.querySelector(".item-section-input").value || "Geral",
        description: row.querySelector(".item-description-input").value || "",
        photoUrl: row.querySelector(".item-photo-input").value || "",
        available: card.querySelector(".item-available-input").checked,
      };
    });
  }

  function bindItemEvents() {
    itemsListEl.querySelectorAll(".item-photo-file-input").forEach(function (input) {
      if (input.dataset.bound === "true") {
        return;
      }

      input.dataset.bound = "true";
      input.addEventListener("change", function (event) {
        var file = event.target.files && event.target.files[0];
        var card = event.target.closest(".item-editor-card");
        var hiddenInput = card && card.querySelector(".item-photo-input");
        var preview = card && card.querySelector(".item-photo-preview");
        var reader;

        if (!file || !hiddenInput || !preview) {
          return;
        }

        reader = new FileReader();
        reader.onload = function (loadEvent) {
          var result = String((loadEvent.target && loadEvent.target.result) || "");
          preview.innerHTML = '<div class="item-photo-preview-empty">Enviando foto...</div>';

          window.appDatabase.uploadItemPhoto(result).then(function (uploadResult) {
            if (!uploadResult || uploadResult.error || !uploadResult.url) {
              preview.innerHTML = '<div class="item-photo-preview-empty">Falha ao enviar foto</div>';
              itemsMessageEl.textContent = (uploadResult && uploadResult.error) || "Não foi possível enviar a foto.";
              itemsMessageEl.dataset.state = "error";
              return;
            }

            hiddenInput.value = uploadResult.url;
            preview.innerHTML =
              '<img class="item-photo-preview-image" src="' + uploadResult.url + '" alt="Foto do item" />';
            state.isEditingItems = true;
            setItemSaveVisible(card, true);
            syncItemsDraftFromDom();
          });
        };
        reader.readAsDataURL(file);
      });
    });
  }

  if (addItemButtonEl) {
    addItemButtonEl.onclick = handleAddItem;
  }

  if (itemsListEl) {
    itemsListEl.addEventListener("input", function (event) {
      state.isEditingItems = true;
      syncItemsDraftFromDom();
      setItemSaveVisible(event.target.closest(".item-editor-card"), true);
    });

    itemsListEl.addEventListener("focusin", function (event) {
      setItemSaveVisible(event.target.closest(".item-editor-card"), true);
    });

    itemsListEl.addEventListener("click", function (event) {
      var saveButton = event.target.closest(".save-item-button");
      var removeButton = event.target.closest(".remove-item-button");

      if (saveButton) {
        event.preventDefault();
        persistSingleItem(saveButton.closest(".item-editor-card"));
        return;
      }

      if (removeButton) {
        event.preventDefault();
        removeItemCard(removeButton.closest(".item-editor-card"));
      }
    });

    itemsListEl.addEventListener("change", function (event) {
      state.isEditingItems = true;
      syncItemsDraftFromDom();
      setItemSaveVisible(event.target.closest(".item-editor-card"), true);
    });
  }

  // -- Dados da loja / taxas por bairro ------------------------------------

  function renderDistrictFees(deliveryFeesByDistrict) {
    var entries = Object.keys(deliveryFeesByDistrict || {})
      .sort()
      .map(function (district) {
        return { district: district, fee: deliveryFeesByDistrict[district] };
      });

    if (!entries.length) {
      districtFeesListEl.innerHTML = '<div class="muted-copy">Nenhum bairro cadastrado ainda.</div>';
      return;
    }

    districtFeesListEl.innerHTML = entries
      .map(function (entry) {
        return (
          '<div class="district-fee-row district-fee-card">' +
          '<div class="district-fee-label">Bairro</div>' +
          '<input class="district-name-input" type="text" value="' +
          entry.district +
          '" placeholder="Bairro" />' +
          '<div class="district-fee-label">Taxa</div>' +
          '<input class="district-fee-input" type="text" value="' +
          window.appDatabase.formatMoney(Number(entry.fee || 0)) +
          '" placeholder="Ex.: R$ 7,99" />' +
          '<button class="qty-btn remove-district-fee-button" type="button">x</button>' +
          "</div>"
        );
      })
      .join("");

    bindDistrictFeeEvents();
  }

  function bindDistrictFeeEvents() {
    districtFeesListEl.querySelectorAll(".remove-district-fee-button").forEach(function (button) {
      button.addEventListener("click", function () {
        button.closest(".district-fee-row").remove();

        if (!districtFeesListEl.querySelector(".district-fee-row")) {
          districtFeesListEl.innerHTML = '<div class="muted-copy">Nenhum bairro cadastrado ainda.</div>';
        }
      });
    });
  }

  function collectDistrictFees() {
    var districtFees = {};

    Array.from(districtFeesListEl.querySelectorAll(".district-fee-row")).forEach(function (row) {
      var district = row.querySelector(".district-name-input").value.trim().toLowerCase();
      var fee = row.querySelector(".district-fee-input").value.trim();

      if (!district || !fee) {
        return;
      }

      districtFees[district] = Number(String(fee).replace("R$", "").replace(/\./g, "").replace(",", ".").trim());
    });

    return districtFees;
  }

  if (addDistrictFeeButtonEl) {
    addDistrictFeeButtonEl.addEventListener("click", function () {
      if (!districtFeesListEl.querySelector(".district-fee-row")) {
        districtFeesListEl.innerHTML = "";
      }

      var row = document.createElement("div");
      row.className = "district-fee-row";
      row.innerHTML =
        '<input class="district-name-input" type="text" placeholder="Bairro" />' +
        '<input class="district-fee-input" type="text" placeholder="Ex.: R$ 7,99" />' +
        '<button class="qty-btn remove-district-fee-button" type="button">x</button>';
      districtFeesListEl.appendChild(row);
      bindDistrictFeeEvents();
    });
  }

  function collectItems() {
    if (!itemsListEl) {
      return state.itemsDraft;
    }
    return Array.from(itemsListEl.querySelectorAll(".item-editor-card"))
      .map(function (card, index) {
        var existing = state.itemsDraft[index] || null;
        var row = card.querySelector(".item-editor-row");
        return {
          id: existing ? existing.id : "",
          name: row.querySelector(".item-name-input").value.trim(),
          price: Number(row.querySelector(".item-price-input").value || 0),
          promoPrice: row.querySelector(".item-promo-price-input").value
            ? Number(row.querySelector(".item-promo-price-input").value)
            : null,
          section: row.querySelector(".item-section-input").value.trim() || "Geral",
          description: row.querySelector(".item-description-input").value.trim(),
          photoUrl: row.querySelector(".item-photo-input").value.trim(),
          available: card.querySelector(".item-available-input").checked,
        };
      })
      .filter(function (item) {
        return item.name;
      });
  }

  function getCurrentStore() {
    return window.appDatabase.getStoreById(state.storeId);
  }

  function getDraftStore(overrides) {
    var currentStore = getCurrentStore();
    var draft = {
      id: state.storeId,
      categoryId: currentStore && currentStore.categoryId ? currentStore.categoryId : "comida",
      name: fields.name.value.trim(),
      icon: currentStore && currentStore.icon ? currentStore.icon : "🏪",
      logoUrl: fields.logoUrl
        ? fields.logoUrl.value.trim()
        : currentStore && currentStore.logoUrl
        ? currentStore.logoUrl
        : "",
      coverLabel: currentStore && currentStore.coverLabel ? currentStore.coverLabel : "",
      description: fields.description.value.trim(),
      rating: currentStore && currentStore.rating ? currentStore.rating : 4.5,
      deliveryFee: currentStore && currentStore.deliveryFee ? currentStore.deliveryFee : "R$ 0,00",
      deliveryTime: currentStore && currentStore.deliveryTime ? currentStore.deliveryTime : "20-30 min",
      minOrder: Number(fields.minOrder.value || 0),
      openingHours: "",
      openingHoursByDay: currentStore && currentStore.openingHoursByDay ? currentStore.openingHoursByDay : {},
      deliveryFeesByDistrict: collectDistrictFees(),
      isActive: fields.isActive.value === "true",
      priceRange: currentStore && currentStore.priceRange ? currentStore.priceRange : "$$",
      tags: currentStore && currentStore.tags ? currentStore.tags : [],
      subCategory: currentStore && currentStore.subCategory ? currentStore.subCategory : "",
      instagramUrl: fields.instagram.value.trim(),
      facebookUrl: fields.facebook.value.trim(),
      items: collectItems(),
    };

    if (overrides) {
      Object.keys(overrides).forEach(function (key) {
        draft[key] = overrides[key];
      });
    }

    return draft;
  }

  async function saveStoreDraft(overrides) {
    var draft = getDraftStore(overrides);

    if (!draft.name) {
      return null;
    }

    var savedStore = window.appDatabase.upsertStore(draft);
    await window.appDatabase.pushStoreToServer(draft);
    if (savedStore) {
      fillForm(savedStore);
      loadSelectedStore();
    }
    return savedStore;
  }

  function fillForm(store) {
    fields.name.value = store.name || "";
    fields.description.value = store.description || "";
    fields.minOrder.value = store.minOrder || 0;
    fields.instagram.value = store.instagramUrl || "";
    fields.facebook.value = store.facebookUrl || "";
    if (fields.logoUrl) {
      fields.logoUrl.value = store.logoUrl || "";
    }
    if (storeLogoPreviewEl) {
      storeLogoPreviewEl.innerHTML = store.logoUrl
        ? '<img class="item-photo-preview-image" src="' + store.logoUrl + '" alt="Foto da loja" />'
        : '<div class="item-photo-preview-empty">Sem foto</div>';
    }
    syncStoreStatusButtons(store.isActive !== false);
    state.itemsDraft = (store.items || []).map(function (item) {
      return {
        id: item.id || "",
        name: item.name || "",
        price: Number(item.price || 0),
        promoPrice: item.promoPrice != null ? Number(item.promoPrice) : null,
        section: item.section || "Geral",
        description: item.description || "",
        photoUrl: item.photoUrl || "",
        available: item.available !== false,
      };
    });
    renderDistrictFees(store.deliveryFeesByDistrict || {});
    renderItems(state.itemsDraft, true);
    fillHoursInputs(store.openingHoursByDay || {});
    updateKpis();
  }

  function loadSelectedStore() {
    var store = getCurrentStore();

    if (!store) {
      fillForm({ categoryId: window.appDatabase.getCategories()[0].id, items: [] });
      return;
    }

    fillForm(store);
    panelTitleEl.textContent = store.name;
    refreshSubtitle();
    syncStoreStatusButtons(store.isActive !== false);
  }

  if (storeLogoFileInputEl) {
    storeLogoFileInputEl.addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      var reader;

      if (!file || !storeLogoInputEl || !storeLogoPreviewEl) {
        return;
      }

      reader = new FileReader();
      reader.onload = function (loadEvent) {
        var result = String((loadEvent.target && loadEvent.target.result) || "");
        storeLogoPreviewEl.innerHTML = '<div class="item-photo-preview-empty">Enviando foto...</div>';

        window.appDatabase.uploadItemPhoto(result).then(function (uploadResult) {
          if (!uploadResult || uploadResult.error || !uploadResult.url) {
            storeLogoPreviewEl.innerHTML = '<div class="item-photo-preview-empty">Falha ao enviar foto</div>';
            storeMessageEl.textContent = (uploadResult && uploadResult.error) || "Não foi possível enviar a foto.";
            storeMessageEl.dataset.state = "error";
            return;
          }

          storeLogoInputEl.value = uploadResult.url;
          storeLogoPreviewEl.innerHTML =
            '<img class="item-photo-preview-image" src="' + uploadResult.url + '" alt="Foto da loja" />';
          storeMessageEl.textContent = "Foto enviada. Clique em \"Salvar dados da loja\" para confirmar.";
          storeMessageEl.dataset.state = "success";
        });
      };
      reader.readAsDataURL(file);
    });
  }

  if (storeFormEl) {
    storeFormEl.addEventListener("submit", async function (event) {
      event.preventDefault();

      var draft = getDraftStore();

      if (!draft.name) {
        storeMessageEl.textContent = "Informe o nome da loja.";
        return;
      }

      var savedStore = await saveStoreDraft();
      if (savedStore) {
        storeMessageEl.textContent = "Loja atualizada com sucesso.";
        storeMessageEl.dataset.state = "success";
      } else {
        storeMessageEl.textContent = "Não foi possível salvar a loja.";
        storeMessageEl.dataset.state = "error";
      }
    });
  }

  // -- Horarios de funcionamento -------------------------------------------

  function fillHoursInputs(openingHoursByDay) {
    hoursInputEls.forEach(function (input) {
      input.value = openingHoursByDay[input.dataset.day] || "";
    });
  }

  function collectHoursInputs() {
    var byDay = {};
    hoursInputEls.forEach(function (input) {
      var value = input.value.trim();
      if (value) {
        byDay[input.dataset.day] = value;
      }
    });
    return byDay;
  }

  if (saveHoursButtonEl) {
    saveHoursButtonEl.addEventListener("click", async function () {
      hoursMessageEl.textContent = "Salvando...";
      hoursMessageEl.dataset.state = "";

      var savedStore = await saveStoreDraft({ openingHoursByDay: collectHoursInputs() });

      if (savedStore) {
        hoursMessageEl.textContent = "Horários salvos com sucesso.";
        hoursMessageEl.dataset.state = "success";
      } else {
        hoursMessageEl.textContent = "Não foi possível salvar os horários.";
        hoursMessageEl.dataset.state = "error";
      }
    });
  }

  // -- Cupons / promocoes ---------------------------------------------------

  function renderCoupons(coupons) {
    if (!couponsListEl) {
      return;
    }

    if (!coupons.length) {
      couponsListEl.innerHTML = '<div class="empty-state">Nenhum cupom criado ainda.</div>';
      return;
    }

    couponsListEl.innerHTML = coupons
      .map(function (coupon) {
        var valueLabel = coupon.type === "fixed" ? window.appDatabase.formatMoney(coupon.value) : coupon.value + "%";
        var usesLabel = coupon.usesCount + (coupon.maxUses != null ? " / " + coupon.maxUses : "") + " usos";

        return (
          '<div class="coupon-card' +
          (coupon.isActive ? "" : " coupon-card-inactive") +
          '" data-code="' +
          coupon.code +
          '">' +
          '<div class="coupon-card-top">' +
          "<strong>" +
          coupon.code +
          "</strong>" +
          '<span class="status-pill">' +
          (coupon.isActive ? "Ativo" : "Inativo") +
          "</span>" +
          "</div>" +
          '<div class="coupon-card-meta">' +
          "<span>" +
          valueLabel +
          " de desconto</span>" +
          "<span>Pedido mínimo: " +
          window.appDatabase.formatMoney(coupon.minOrder || 0) +
          "</span>" +
          "<span>" +
          usesLabel +
          "</span>" +
          (coupon.expiresAt ? "<span>Expira em " + coupon.expiresAt + "</span>" : "") +
          "</div>" +
          '<button class="secondary-button small-button coupon-toggle-button" type="button" data-code="' +
          coupon.code +
          '">' +
          (coupon.isActive ? "Desativar" : "Ativar") +
          "</button>" +
          "</div>"
        );
      })
      .join("");

    couponsListEl.querySelectorAll(".coupon-toggle-button").forEach(function (button) {
      button.addEventListener("click", async function () {
        button.disabled = true;
        await window.appDatabase.toggleCoupon(state.storeId, button.dataset.code);
        loadAndRenderCoupons();
      });
    });
  }

  async function loadAndRenderCoupons() {
    if (!state.storeId || !couponsListEl) {
      return;
    }
    var coupons = await window.appDatabase.listCoupons(state.storeId);
    renderCoupons(coupons);
  }

  if (couponFormEl) {
    couponFormEl.addEventListener("submit", async function (event) {
      event.preventDefault();
      couponMessageEl.textContent = "Salvando...";

      var result = await window.appDatabase.saveCoupon({
        storeId: state.storeId,
        code: couponCodeInputEl.value.trim(),
        type: couponTypeInputEl.value,
        value: Number(couponValueInputEl.value || 0),
        minOrder: Number(couponMinOrderInputEl.value || 0),
        maxUses: couponMaxUsesInputEl.value ? Number(couponMaxUsesInputEl.value) : null,
        expiresAt: couponExpiresInputEl.value || null,
      });

      if (result && result.error) {
        couponMessageEl.textContent = result.error;
        return;
      }

      couponMessageEl.textContent = "Cupom salvo com sucesso.";
      couponFormEl.reset();
      loadAndRenderCoupons();
    });
  }

  // -- Métricas / financeiro --------------------------------------------------

  function renderMetrics(metrics) {
    if (!metricsContentEl) {
      return;
    }

    var salesByDay = metrics.salesByDay || [];
    var topItems = metrics.topItems || [];
    var last7 = salesByDay.slice(0, 7).reduce(function (total, day) { return total + day.total; }, 0);
    var last30 = salesByDay.reduce(function (total, day) { return total + day.total; }, 0);
    var maxDayTotal = salesByDay.reduce(function (max, day) { return Math.max(max, day.total); }, 0) || 1;
    var maxItemQty = topItems.reduce(function (max, item) { return Math.max(max, item.quantity); }, 0) || 1;

    metricsContentEl.innerHTML =
      '<div class="admin-dash-kpi-row admin-dash-kpi-row-2">' +
      '<div class="admin-dash-kpi-card">' +
      '<span class="admin-dash-kpi-label">Vendido nos últimos 7 dias</span>' +
      "<strong>" +
      window.appDatabase.formatMoney(last7) +
      "</strong>" +
      "</div>" +
      '<div class="admin-dash-kpi-card">' +
      '<span class="admin-dash-kpi-label">Vendido nos últimos 30 dias</span>' +
      "<strong>" +
      window.appDatabase.formatMoney(last30) +
      "</strong>" +
      "</div>" +
      "</div>" +
      '<div class="section-header"><h2>Vendas por dia</h2></div>' +
      (salesByDay.length
        ? '<div class="metrics-bar-list">' +
          salesByDay
            .map(function (day) {
              var pct = Math.round((day.total / maxDayTotal) * 100);
              return (
                '<div class="metrics-bar-row">' +
                '<span class="metrics-bar-label">' +
                day.day +
                "</span>" +
                '<div class="metrics-bar-track"><div class="metrics-bar-fill" style="width:' +
                pct +
                '%"></div></div>' +
                '<span class="metrics-bar-value">' +
                window.appDatabase.formatMoney(day.total) +
                "</span>" +
                "</div>"
              );
            })
            .join("") +
          "</div>"
        : '<div class="empty-state">Ainda não ha vendas registradas.</div>') +
      '<div class="section-header"><h2>Itens mais vendidos</h2></div>' +
      (topItems.length
        ? '<div class="metrics-bar-list">' +
          topItems
            .map(function (item) {
              var pct = Math.round((item.quantity / maxItemQty) * 100);
              return (
                '<div class="metrics-bar-row">' +
                '<span class="metrics-bar-label">' +
                window.appDatabase.escapeHtml(item.name) +
                "</span>" +
                '<div class="metrics-bar-track"><div class="metrics-bar-fill" style="width:' +
                pct +
                '%"></div></div>' +
                '<span class="metrics-bar-value">' +
                item.quantity +
                "x</span>" +
                "</div>"
              );
            })
            .join("") +
          "</div>"
        : '<div class="empty-state">Ainda não ha itens vendidos.</div>');
  }

  async function loadAndRenderMetrics() {
    if (!state.storeId || !metricsContentEl) {
      return;
    }
    var metrics = await window.appDatabase.getOwnerMetrics(state.storeId);
    renderMetrics(metrics);
  }

  // -- Avaliacoes -------------------------------------------------------------

  function starString(rating) {
    var rounded = Math.round(Number(rating) || 0);
    var filled = "★".repeat(Math.max(0, Math.min(5, rounded)));
    var empty = "☆".repeat(5 - Math.max(0, Math.min(5, rounded)));
    return filled + empty;
  }

  function reviewItemMarkup(review, itemName) {
    var escapeHtml = window.appDatabase.escapeHtml;
    var hiddenClass = review.hidden ? " is-hidden" : "";

    return (
      '<div class="admin-dash-review-item' + hiddenClass + '">' +
      (itemName
        ? '<span class="admin-dash-review-item-name">' + escapeHtml(itemName) + "</span>"
        : "") +
      '<div class="admin-dash-review-top">' +
      "<strong>" + escapeHtml(review.customerName || "Cliente") + "</strong>" +
      '<span class="admin-dash-review-stars">' + starString(review.rating) + "</span>" +
      "</div>" +
      (review.comment
        ? '<p class="admin-dash-review-comment">' + escapeHtml(review.comment) + "</p>"
        : "") +
      '<span class="admin-dash-review-date">' +
      new Date(review.createdAt).toLocaleDateString("pt-BR") +
      "</span>" +
      '<div class="admin-dash-review-actions">' +
      (review.hidden
        ? '<span class="admin-dash-review-hidden-badge">Escondida</span>'
        : "") +
      '<button type="button" class="admin-dash-review-toggle-button" data-review-id="' +
      review.id +
      '" data-review-hidden="' +
      (review.hidden ? "1" : "0") +
      '">' +
      (review.hidden ? "Reexibir" : "Esconder") +
      "</button>" +
      "</div>" +
      "</div>"
    );
  }

  function renderReviews(storeReviews) {
    if (!reviewsSummaryEl || !reviewsListEl) {
      return;
    }

    var visibleReviews = storeReviews.filter(function (review) {
      return !review.hidden;
    });

    if (visibleReviews.length) {
      var sum = visibleReviews.reduce(function (total, review) {
        return total + Number(review.rating || 0);
      }, 0);
      var average = sum / visibleReviews.length;
      reviewsSummaryEl.innerHTML =
        "<strong>" + average.toFixed(1) + "</strong>" +
        "<span>" + starString(average) + " · " + visibleReviews.length + " avaliação(ões) visível(eis)</span>";
    } else {
      reviewsSummaryEl.innerHTML = '<span>Sua loja ainda não recebeu avaliações visíveis.</span>';
    }

    if (!storeReviews.length) {
      reviewsListEl.innerHTML = '<div class="admin-dash-empty-hint">Nenhuma avaliação ainda.</div>';
      return;
    }

    reviewsListEl.innerHTML = storeReviews
      .map(function (review) {
        return reviewItemMarkup(review, null);
      })
      .join("");
  }

  function renderItemReviews(itemReviews) {
    if (!itemReviewsListEl) {
      return;
    }

    if (!itemReviews.length) {
      itemReviewsListEl.innerHTML = '<div class="admin-dash-empty-hint">Nenhuma avaliação de item ainda.</div>';
      return;
    }

    itemReviewsListEl.innerHTML = itemReviews
      .map(function (review) {
        return reviewItemMarkup(review, review.itemName);
      })
      .join("");
  }

  async function loadAndRenderReviews() {
    if (!state.storeId) {
      return;
    }
    var data = await window.appDatabase.getStoreReviewsForModeration(state.storeId);
    renderReviews(data.storeReviews || []);
    renderItemReviews(data.itemReviews || []);
  }

  function handleReviewToggleClick(event) {
    var button = event.target.closest(".admin-dash-review-toggle-button");
    if (!button) {
      return;
    }

    var reviewId = button.dataset.reviewId;
    var currentlyHidden = button.dataset.reviewHidden === "1";
    var isItemReview = button.closest("#item-reviews-list") !== null;

    button.disabled = true;

    var request = isItemReview
      ? window.appDatabase.setItemReviewVisibility(reviewId, !currentlyHidden)
      : window.appDatabase.setReviewVisibility(reviewId, !currentlyHidden);

    request.then(function (result) {
      button.disabled = false;
      if (result && result.error) {
        window.alert(result.error);
        return;
      }
      loadAndRenderReviews();
    });
  }

  if (reviewsListEl) {
    reviewsListEl.addEventListener("click", handleReviewToggleClick);
  }
  if (itemReviewsListEl) {
    itemReviewsListEl.addEventListener("click", handleReviewToggleClick);
  }

  // -- E-mail de recuperação -------------------------------------------------
  // A senha não pode mais ser trocada por aqui (só pela tela de login, via
  // "Esqueceu sua senha?") - isso aqui só cadastra/atualiza o e-mail que
  // recebe o link de redefinição.

  if (ownerEmailInputEl) {
    ownerEmailInputEl.value = session.email || "";
  }

  if (ownerEmailFormEl) {
    ownerEmailFormEl.addEventListener("submit", async function (event) {
      event.preventDefault();

      var email = ownerEmailInputEl.value.trim();

      ownerEmailMessageEl.textContent = "Salvando...";
      ownerEmailMessageEl.dataset.state = "";

      var result = await window.appDatabase.updateOwnerEmail(email);

      if (!result || result.error) {
        ownerEmailMessageEl.textContent = (result && result.error) || "Não foi possível salvar o e-mail.";
        ownerEmailMessageEl.dataset.state = "error";
        return;
      }

      session.email = result.email;
      window.appDatabase.saveOwnerSession(session);

      ownerEmailMessageEl.textContent = "E-mail salvo com sucesso.";
      ownerEmailMessageEl.dataset.state = "success";
    });
  }

  // -- Inicializacao ---------------------------------------------------------

  async function init() {
    await window.appDatabase.syncCatalogFromServer();
    loadSelectedStore();
    await window.appDatabase.syncOwnerOrdersFromServer(state.storeId);
    renderOrders();
    switchSection("pedidos");
    startAutoRefresh();
  }

  init();
})();
