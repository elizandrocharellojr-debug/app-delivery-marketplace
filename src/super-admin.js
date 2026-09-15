// Painel interno de administração da plataforma (visão do dono do app, não
// do lojista). Depois do login, mostra um dashboard desktop com menu lateral:
// Visão geral (KPIs do dia, gráfico de pedidos por hora, aprovações
// pendentes de parceiros e últimos pedidos), Pedidos (todos os pedidos da
// plataforma), Estabelecimentos (criar loja nova + entrar como lojista,
// like antes), Prestadores (placeholder até o módulo de Serviços existir),
// Usuários (clientes cadastrados) e Financeiro (faturamento por loja).
// Não usa localStorage pra guardar a própria sessão de admin, porque e um
// acesso sensivel: fechar a aba exige logar de novo.
(function () {
  "use strict";

  const OWNER_SESSION_KEY = "morretes-delivery-owner-session";

  let adminToken = "";
  let adminUsername = "";
  const loadedSections = {};

  const loginScreenEl = document.getElementById("admin-login-screen");
  const panelScreenEl = document.getElementById("admin-panel-screen");
  const loginFormEl = document.getElementById("admin-login-form");
  const loginMessageEl = document.getElementById("admin-login-message");
  const usernameInputEl = document.getElementById("admin-username-input");
  const passwordInputEl = document.getElementById("admin-password-input");

  const createStoreFormEl = document.getElementById("create-store-form");
  const createStoreMessageEl = document.getElementById("create-store-message");
  const categorySelectEl = document.getElementById("store-category-input");
  const credentialsCardEl = document.getElementById("credentials-card");
  const credentialsUsernameEl = document.getElementById("credentials-username");
  const credentialsPasswordEl = document.getElementById("credentials-password");
  const createAnotherButtonEl = document.getElementById("create-another-button");
  const logoutButtonEl = document.getElementById("admin-logout-button");

  const storesListEl = document.getElementById("stores-list");
  const storesListMessageEl = document.getElementById("stores-list-message");

  const createTaxiDriverFormEl = document.getElementById("create-taxi-driver-form");
  const createTaxiDriverMessageEl = document.getElementById("create-taxi-driver-message");
  const taxiCredentialsCardEl = document.getElementById("taxi-credentials-card");
  const taxiCredentialsUsernameEl = document.getElementById("taxi-credentials-username");
  const taxiCredentialsPasswordEl = document.getElementById("taxi-credentials-password");
  const createAnotherTaxiDriverButtonEl = document.getElementById("create-another-taxi-driver-button");
  const taxiDriversListEl = document.getElementById("taxi-drivers-list");
  const paymentErrorsListMessageEl = document.getElementById("payment-errors-list-message");
  const paymentErrorsListBodyEl = document.getElementById("payment-errors-list-body");
  const taxiDriversListMessageEl = document.getElementById("taxi-drivers-list-message");
  const providersListEl = document.getElementById("providers-list");
  const providersListMessageEl = document.getElementById("providers-list-message");
  const providerReviewsListEl = document.getElementById("provider-reviews-list");
  const providerVisitCommissionFormEl = document.getElementById("provider-visit-commission-form");
  const providerVisitCommissionInputEl = document.getElementById("provider-visit-commission-input");
  const providerVisitCommissionMessageEl = document.getElementById("provider-visit-commission-message");

  const createProviderFormEl = document.getElementById("create-provider-form");
  const createProviderMessageEl = document.getElementById("create-provider-message");
  const providerCredentialsCardEl = document.getElementById("provider-credentials-card");
  const providerCredentialsUsernameEl = document.getElementById("provider-credentials-username");
  const providerCredentialsPasswordEl = document.getElementById("provider-credentials-password");
  const createAnotherProviderButtonEl = document.getElementById("create-another-provider-button");

  const createChipFormEl = document.getElementById("create-chip-form");
  const createChipMessageEl = document.getElementById("create-chip-message");
  const chipLabelInputEl = document.getElementById("chip-label-input");
  const chipIconInputEl = document.getElementById("chip-icon-input");
  const chipParentInputEl = document.getElementById("chip-parent-input");
  const chipKindInputEl = document.getElementById("chip-kind-input");
  const chipCategoryInputEl = document.getElementById("chip-category-input");
  const chipSubCategoryInputEl = document.getElementById("chip-subcategory-input");
  const chipSearchInputEl = document.getElementById("chip-search-input");
  const chipKindFieldEl = document.getElementById("chip-kind-field");
  const chipCategoryFieldEl = document.getElementById("chip-category-field");
  const chipSubCategoryFieldEl = document.getElementById("chip-subcategory-field");
  const chipSearchFieldEl = document.getElementById("chip-search-field");
  const chipSubmitButtonEl = document.getElementById("chip-submit-button");
  const chipCancelEditButtonEl = document.getElementById("chip-cancel-edit-button");
  const chipsListEl = document.getElementById("chips-list");
  const chipsListMessageEl = document.getElementById("chips-list-message");

  let chipsCache = [];
  let editingChipId = "";

  const navItemEls = Array.prototype.slice.call(document.querySelectorAll(".admin-dash-nav-item"));
  const sectionTitleEl = document.getElementById("admin-dash-section-title");
  const todayEl = document.getElementById("admin-dash-today");
  const settingsAdminNameEl = document.getElementById("settings-admin-name");

  const kpiOrdersTodayEl = document.getElementById("kpi-orders-today");
  const kpiOrdersDeltaEl = document.getElementById("kpi-orders-delta");
  const kpiGmvTodayEl = document.getElementById("kpi-gmv-today");
  const kpiGmvDeltaEl = document.getElementById("kpi-gmv-delta");
  const kpiUsersTodayEl = document.getElementById("kpi-users-today");
  const kpiUsersDeltaEl = document.getElementById("kpi-users-delta");

  const chartEl = document.getElementById("admin-dash-chart");
  const approvalsListEl = document.getElementById("admin-dash-approvals-list");
  const approvalsCountBadgeEl = document.getElementById("approvals-count-badge");
  const recentOrdersBodyEl = document.getElementById("admin-dash-recent-orders-body");

  const ordersBodyEl = document.getElementById("admin-dash-orders-body");
  const usersBodyEl = document.getElementById("admin-dash-users-body");
  const financeTotalOrdersEl = document.getElementById("finance-total-orders");
  const financeTotalGmvEl = document.getElementById("finance-total-gmv");
  const financeAvgTicketEl = document.getElementById("finance-avg-ticket");
  const financeBodyEl = document.getElementById("admin-dash-finance-body");
  const financePeriodFormEl = document.getElementById("finance-period-form");
  const financeStartInputEl = document.getElementById("finance-start-input");
  const financeEndInputEl = document.getElementById("finance-end-input");
  const financePeriodClearEl = document.getElementById("finance-period-clear");

  const commissionFormEl = document.getElementById("commission-form");
  const commissionThreshold1InputEl = document.getElementById("commission-threshold1-input");
  const commissionThreshold2InputEl = document.getElementById("commission-threshold2-input");
  const commissionRate1InputEl = document.getElementById("commission-rate1-input");
  const commissionRate2InputEl = document.getElementById("commission-rate2-input");
  const commissionRate3InputEl = document.getElementById("commission-rate3-input");
  const commissionMessageEl = document.getElementById("commission-message");
  const taxiPricingFormEl = document.getElementById("taxi-pricing-form");
  const taxiPricingBaseInputEl = document.getElementById("taxi-pricing-base-input");
  const taxiPricingKmInputEl = document.getElementById("taxi-pricing-km-input");
  const taxiPricingMinInputEl = document.getElementById("taxi-pricing-min-input");
  const taxiPricingMinimumInputEl = document.getElementById("taxi-pricing-minimum-input");
  const taxiPricingMessageEl = document.getElementById("taxi-pricing-message");
  const settlementPreviewFormEl = document.getElementById("settlement-preview-form");
  const settlementStartInputEl = document.getElementById("settlement-start-input");
  const settlementEndInputEl = document.getElementById("settlement-end-input");
  const settlementPreviewMessageEl = document.getElementById("settlement-preview-message");
  const settlementPreviewWrapEl = document.getElementById("settlement-preview-wrap");
  const settlementPreviewBodyEl = document.getElementById("settlement-preview-body");
  const settlementCloseActionsEl = document.getElementById("settlement-close-actions");
  const settlementCloseButtonEl = document.getElementById("settlement-close-button");
  const storeBalancesBodyEl = document.getElementById("store-balances-body");
  const settlementsHistoryBodyEl = document.getElementById("settlements-history-body");
  let currentPreviewRange = null;

  const taxiCommissionFormEl = document.getElementById("taxi-commission-form");
  const taxiCommissionThreshold1InputEl = document.getElementById("taxi-commission-threshold1-input");
  const taxiCommissionThreshold2InputEl = document.getElementById("taxi-commission-threshold2-input");
  const taxiCommissionRate1InputEl = document.getElementById("taxi-commission-rate1-input");
  const taxiCommissionRate2InputEl = document.getElementById("taxi-commission-rate2-input");
  const taxiCommissionRate3InputEl = document.getElementById("taxi-commission-rate3-input");
  const taxiCommissionMessageEl = document.getElementById("taxi-commission-message");
  const taxiSettlementPreviewFormEl = document.getElementById("taxi-settlement-preview-form");
  const taxiSettlementStartInputEl = document.getElementById("taxi-settlement-start-input");
  const taxiSettlementEndInputEl = document.getElementById("taxi-settlement-end-input");
  const taxiSettlementPreviewMessageEl = document.getElementById("taxi-settlement-preview-message");
  const taxiSettlementPreviewWrapEl = document.getElementById("taxi-settlement-preview-wrap");
  const taxiSettlementPreviewBodyEl = document.getElementById("taxi-settlement-preview-body");
  const taxiSettlementCloseActionsEl = document.getElementById("taxi-settlement-close-actions");
  const taxiSettlementCloseButtonEl = document.getElementById("taxi-settlement-close-button");
  const taxiBalancesBodyEl = document.getElementById("taxi-balances-body");
  const taxiSettlementsHistoryBodyEl = document.getElementById("taxi-settlements-history-body");
  let currentTaxiPreviewRange = null;

  const SECTION_TITLES = {
    overview: ["Visão geral da plataforma", "Morretes - PR"],
    orders: ["Pedidos", "Todos os pedidos da plataforma"],
    stores: ["Estabelecimentos", "Criar lojas e gerenciar parceiros"],
    home: ["Ícones da Home", "Crie e edite os ícones da tela inicial do cliente"],
    providers: ["Prestadores", "Profissionais de serviço cadastrados"],
    taxi: ["Taxistas", "Cadastre taxistas e acompanhe quem está online"],
    users: ["Usuários", "Clientes cadastrados no app"],
    finance: ["Financeiro", "Faturamento da plataforma"],
    settlements: ["Fechamento", "Repasse por loja e comissão da plataforma"],
    "taxi-settlements": ["Comissão táxi", "Repasse por taxista e comissão de corrida"],
    payments: ["Pagamentos", "Últimas falhas reais do Mercado Pago"],
    marketing: ["Notificações", "Envie notificações push pra todos os clientes"],
    settings: ["Configurações", "Preferências da conta de administrador"]
  };

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL"
    });
  }

  function formatDateTime(value) {
    if (!value) {
      return "-";
    }
    return new Date(value).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function shortOrderId(id) {
    if (!id) {
      return "-";
    }
    return "#" + String(id).replace("PED-", "").slice(-6);
  }

  function setMessage(element, text, state) {
    element.textContent = text || "";
    if (state) {
      element.dataset.state = state;
    } else {
      delete element.dataset.state;
    }
  }

  function authorizedFetch(path, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + adminToken });
    return fetch(path, Object.assign({}, opts, { headers })).then(function (response) {
      if (response.status === 401) {
        showLogin();
        throw new Error("unauthorized");
      }
      return response.json().then(function (body) {
        return { ok: response.ok, status: response.status, body };
      });
    });
  }

  function showPanel() {
    loginScreenEl.hidden = true;
    panelScreenEl.hidden = false;
    settingsAdminNameEl.textContent = adminUsername || "administrador";
    todayEl.textContent = new Date().toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "2-digit",
      month: "long"
    });
    loadCategories();
    for (const key in loadedSections) {
      delete loadedSections[key];
    }
    loadDashboard();
    setupSectionNav();
  }

  function showLogin() {
    adminToken = "";
    adminUsername = "";
    panelScreenEl.hidden = true;
    loginScreenEl.hidden = false;
    passwordInputEl.value = "";
  }

  function setupSectionNav() {
    navItemEls.forEach(function (item) {
      item.onclick = function () {
        const section = item.dataset.section;
        switchSection(section);
      };
    });
  }

  function switchSection(section) {
    navItemEls.forEach(function (item) {
      item.classList.toggle("active", item.dataset.section === section);
    });

    document.querySelectorAll(".admin-dash-section").forEach(function (panel) {
      panel.hidden = panel.id !== "admin-section-" + section;
    });

    const titles = SECTION_TITLES[section] || ["", ""];
    sectionTitleEl.textContent = titles[0];
    document.querySelector(".admin-dash-topbar-sub").innerHTML =
      titles[1] + " · <span id=\"admin-dash-today\">" + todayEl.textContent + "</span>";

    if (!loadedSections[section]) {
      loadedSections[section] = true;
      if (section === "orders") {
        loadOrders();
      } else if (section === "stores") {
        loadStores();
      } else if (section === "home") {
        loadChips();
      } else if (section === "users") {
        loadUsers();
      } else if (section === "finance") {
        loadFinance();
      } else if (section === "taxi") {
        loadTaxiDrivers();
        loadTaxiPricing();
      } else if (section === "payments") {
        loadPaymentErrors();
      } else if (section === "marketing") {
        loadMarketingHistory();
      } else if (section === "settlements") {
        loadCommissionSetting();
        loadStoreBalances();
        loadSettlementsHistory();
      } else if (section === "taxi-settlements") {
        loadTaxiCommissionSetting();
        loadTaxiBalances();
        loadTaxiSettlementsHistory();
      } else if (section === "providers") {
        loadProviders();
        loadProviderReviews();
        loadProviderVisitCommission();
      }
    }
  }

  // -- Visao geral ----------------------------------------------------------

  function renderDelta(el, pct) {
    const value = Number(pct) || 0;
    const sign = value > 0 ? "+" : "";
    el.textContent = sign + value + "% vs ontem";
    el.classList.remove("is-positive", "is-negative");
    if (value > 0) {
      el.classList.add("is-positive");
    } else if (value < 0) {
      el.classList.add("is-negative");
    }
  }

  function renderChart(ordersByHour) {
    chartEl.innerHTML = "";

    if (!ordersByHour || !ordersByHour.length) {
      const empty = document.createElement("p");
      empty.className = "admin-dash-empty-hint";
      empty.textContent = "Nenhum pedido registrado hoje ainda.";
      chartEl.appendChild(empty);
      return;
    }

    let maxValue = 1;
    ordersByHour.forEach(function (bucket) {
      maxValue = Math.max(maxValue, bucket.comida, bucket.servicos);
    });

    ordersByHour.forEach(function (bucket) {
      const group = document.createElement("div");
      group.className = "admin-dash-chart-bar-group";

      const bars = document.createElement("div");
      bars.className = "admin-dash-chart-bars";

      const foodBar = document.createElement("div");
      foodBar.className = "admin-dash-chart-bar bar-food";
      foodBar.style.height = bucket.comida > 0 ? Math.max(4, Math.round((bucket.comida / maxValue) * 100)) + "%" : "0%";
      foodBar.title = bucket.comida + " pedido(s) de comida as " + bucket.hour + "h";

      const serviceBar = document.createElement("div");
      serviceBar.className = "admin-dash-chart-bar bar-service";
      serviceBar.style.height = bucket.servicos > 0 ? Math.max(4, Math.round((bucket.servicos / maxValue) * 100)) + "%" : "0%";
      serviceBar.title = bucket.servicos + " pedido(s) de serviço às " + bucket.hour + "h";

      bars.appendChild(foodBar);
      bars.appendChild(serviceBar);

      const label = document.createElement("span");
      label.className = "admin-dash-chart-bar-label";
      label.textContent = bucket.hour + "h";

      group.appendChild(bars);
      group.appendChild(label);
      chartEl.appendChild(group);
    });
  }

  function updateLeadStatus(leadId, status, buttonEl) {
    const groupButtons = buttonEl.parentElement.querySelectorAll("button");
    groupButtons.forEach(function (btn) {
      btn.disabled = true;
    });

    authorizedFetch("/api/admin/partner-leads/" + encodeURIComponent(leadId) + "/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: status })
    })
      .then(function () {
        loadDashboard();
      })
      .catch(function () {
        groupButtons.forEach(function (btn) {
          btn.disabled = false;
        });
      });
  }

  function renderApprovals(leads, count) {
    approvalsListEl.innerHTML = "";
    approvalsCountBadgeEl.textContent = String(count || 0);

    if (!leads || !leads.length) {
      const empty = document.createElement("p");
      empty.className = "admin-dash-empty-hint";
      empty.textContent = "Nenhuma aprovação pendente.";
      approvalsListEl.appendChild(empty);
      return;
    }

    leads.forEach(function (lead) {
      const item = document.createElement("div");
      item.className = "admin-dash-approval-item";

      const info = document.createElement("div");
      info.className = "admin-dash-approval-info";
      const name = document.createElement("strong");
      name.textContent = lead.name;
      const meta = document.createElement("span");
      meta.textContent =
        (lead.kind === "servico" ? "Prestador de serviço" : "Estabelecimento") + " · " + lead.phone;
      info.appendChild(name);
      info.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "admin-dash-approval-actions";

      const approveButton = document.createElement("button");
      approveButton.type = "button";
      approveButton.className = "admin-dash-approve-button";
      approveButton.textContent = "Aprovar";
      approveButton.addEventListener("click", function () {
        updateLeadStatus(lead.id, "aprovado", approveButton);
      });

      const rejectButton = document.createElement("button");
      rejectButton.type = "button";
      rejectButton.className = "admin-dash-reject-button";
      rejectButton.textContent = "Recusar";
      rejectButton.addEventListener("click", function () {
        updateLeadStatus(lead.id, "recusado", rejectButton);
      });

      actions.appendChild(approveButton);
      actions.appendChild(rejectButton);

      item.appendChild(info);
      item.appendChild(actions);
      approvalsListEl.appendChild(item);
    });
  }

  function makeCell(text, className) {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (className) {
      cell.className = className;
    }
    return cell;
  }

  function makeStatusCell(status) {
    const cell = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "status-pill";
    pill.textContent = status || "-";
    cell.appendChild(pill);
    return cell;
  }

  function renderRecentOrders(orders) {
    recentOrdersBodyEl.innerHTML = "";

    if (!orders || !orders.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.className = "admin-dash-empty-hint";
      cell.textContent = "Nenhum pedido ainda.";
      row.appendChild(cell);
      recentOrdersBodyEl.appendChild(row);
      return;
    }

    orders.forEach(function (order) {
      const row = document.createElement("tr");
      row.appendChild(makeCell(shortOrderId(order.id)));
      row.appendChild(makeCell(order.customerName || "-"));
      row.appendChild(makeCell(order.storeName || "-"));
      row.appendChild(makeCell(formatMoney(order.total), "is-money"));
      row.appendChild(makeStatusCell(order.status));
      recentOrdersBodyEl.appendChild(row);
    });
  }

  function loadDashboard() {
    authorizedFetch("/api/admin/dashboard")
      .then(function (result) {
        if (!result.ok) {
          return;
        }
        const data = result.body;
        kpiOrdersTodayEl.textContent = data.ordersToday;
        renderDelta(kpiOrdersDeltaEl, data.ordersTodayDeltaPct);
        kpiGmvTodayEl.textContent = formatMoney(data.gmvToday);
        renderDelta(kpiGmvDeltaEl, data.gmvTodayDeltaPct);
        kpiUsersTodayEl.textContent = data.newUsersToday;
        renderDelta(kpiUsersDeltaEl, data.newUsersTodayDeltaPct);
        renderChart(data.ordersByHour);
        renderApprovals(data.pendingLeads, data.pendingLeadsCount);
        renderRecentOrders(data.recentOrders);
      })
      .catch(function () {
        // Se a sessão expirou, authorizedFetch já mandou pra tela de login.
      });
  }

  // -- Pedidos ----------------------------------------------------------------

  const ordersSearchInputEl = document.getElementById("orders-search-input");
  const ordersSearchFormEl = document.getElementById("orders-search-form");
  let allOrdersCache = [];

  // Pedido ainda ativo (nem entregue nem cancelado) - o admin pode cancelar,
  // o que já dispara o estorno automático se tinha pagamento online pago.
  function orderCanBeCancelledByAdmin(order) {
    return order.status !== "Cancelado" && order.status !== "Entregue";
  }

  // Pedido com pagamento online confirmado que ainda não voltou pro
  // cliente - não importa se está cancelado, entregue, ou de quando é. Se
  // aparecer um problema comprovado depois (mesmo dias/semanas depois da
  // entrega), continua dando pra estornar por aqui.
  function orderHasRefundablePaymentByAdmin(order) {
    return order.paymentStatus === "pago" && order.paymentProvider === "mercadopago";
  }

  function makeOrderActionCell(order) {
    const cell = document.createElement("td");

    if (orderCanBeCancelledByAdmin(order)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button small-button danger-button admin-order-action-button";
      button.textContent = "Cancelar e estornar";
      button.dataset.orderId = order.id;
      button.dataset.action = "cancel";
      cell.appendChild(button);
      return cell;
    }

    if (orderHasRefundablePaymentByAdmin(order)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button small-button admin-order-action-button";
      button.textContent = "Estornar";
      button.dataset.orderId = order.id;
      button.dataset.action = "refund";
      cell.appendChild(button);
      return cell;
    }

    cell.className = "admin-dash-empty-hint";
    cell.textContent = "-";
    return cell;
  }

  function renderOrdersRows(orders) {
    ordersBodyEl.innerHTML = "";

    if (!orders.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "admin-dash-empty-hint";
      cell.textContent = "Nenhum pedido encontrado.";
      row.appendChild(cell);
      ordersBodyEl.appendChild(row);
      return;
    }

    orders.forEach(function (order) {
      const row = document.createElement("tr");
      row.appendChild(makeCell(shortOrderId(order.id)));
      row.appendChild(makeCell(order.customerName || "-"));
      row.appendChild(makeCell(order.storeName || "-"));
      row.appendChild(makeCell(formatMoney(order.total), "is-money"));
      row.appendChild(makeStatusCell(order.status));
      row.appendChild(makeCell(formatDateTime(order.createdAt)));
      row.appendChild(makeOrderActionCell(order));
      ordersBodyEl.appendChild(row);
    });
  }

  // Filtro só no que já foi carregado (sem ida ao servidor de novo) - é só
  // pra achar rápido um pedido antigo específico em meio a até mil linhas.
  function applyOrdersSearch() {
    const query = (ordersSearchInputEl && ordersSearchInputEl.value.trim().toLowerCase()) || "";

    if (!query) {
      renderOrdersRows(allOrdersCache);
      return;
    }

    const filtered = allOrdersCache.filter(function (order) {
      return (
        String(order.id || "").toLowerCase().indexOf(query) >= 0 ||
        String(order.customerName || "").toLowerCase().indexOf(query) >= 0 ||
        String(order.storeName || "").toLowerCase().indexOf(query) >= 0
      );
    });

    renderOrdersRows(filtered);
  }

  function loadOrders() {
    ordersBodyEl.innerHTML = "<tr><td colspan=\"7\" class=\"admin-dash-empty-hint\">Carregando...</td></tr>";

    authorizedFetch("/api/admin/orders")
      .then(function (result) {
        if (!result.ok) {
          return;
        }
        allOrdersCache = result.body.orders || [];
        applyOrdersSearch();
      })
      .catch(function () {});
  }

  if (ordersSearchFormEl) {
    ordersSearchFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      applyOrdersSearch();
    });
  }

  if (ordersSearchInputEl) {
    ordersSearchInputEl.addEventListener("input", applyOrdersSearch);
  }

  if (ordersBodyEl) {
    ordersBodyEl.addEventListener("click", async function (event) {
      const button = event.target.closest(".admin-order-action-button");
      if (!button) {
        return;
      }

      const orderId = button.dataset.orderId;
      const action = button.dataset.action;
      const confirmText =
        action === "cancel"
          ? "Cancelar este pedido? Se já tinha pagamento online confirmado, o estorno é solicitado automaticamente."
          : "Estornar o pagamento deste pedido? Isso não muda o status atual dele (ex.: se já foi entregue, continua entregue).";

      if (!window.confirm(confirmText)) {
        return;
      }

      button.disabled = true;
      button.textContent = "Processando...";

      try {
        const result = await authorizedFetch("/api/admin/orders/" + encodeURIComponent(orderId) + "/refund", {
          method: "POST"
        });

        if (!result.ok) {
          window.alert((result.body && result.body.error) || "Não foi possível concluir a ação.");
        } else if (result.body.refund && result.body.refund.attempted && !result.body.refund.success) {
          window.alert(
            "O estorno não foi concluído agora (" +
              (result.body.refund.reason || "erro desconhecido") +
              "). Pode tentar de novo por aqui em instantes."
          );
        }
      } catch (error) {
        // authorizedFetch já redireciona pro login se a sessão expirou.
      }

      loadOrders();
    });
  }

  // -- Usuários -----------------------------------------------------------

  function loadUsers() {
    usersBodyEl.innerHTML = "<tr><td colspan=\"4\" class=\"admin-dash-empty-hint\">Carregando...</td></tr>";

    authorizedFetch("/api/admin/customers")
      .then(function (result) {
        if (!result.ok) {
          return;
        }
        const customers = result.body.customers || [];
        usersBodyEl.innerHTML = "";

        if (!customers.length) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = 4;
          cell.className = "admin-dash-empty-hint";
          cell.textContent = "Nenhum usuário cadastrado ainda.";
          row.appendChild(cell);
          usersBodyEl.appendChild(row);
          return;
        }

        customers.forEach(function (customer) {
          const row = document.createElement("tr");
          row.appendChild(makeCell(customer.name || "-"));
          row.appendChild(makeCell(customer.email || "-"));
          row.appendChild(makeCell(customer.phone || "-"));
          row.appendChild(makeCell(formatDateTime(customer.createdAt)));
          usersBodyEl.appendChild(row);
        });
      })
      .catch(function () {});
  }

  // -- Financeiro -----------------------------------------------------------

  function loadFinance(start, end) {
    financeBodyEl.innerHTML = "<tr><td colspan=\"4\" class=\"admin-dash-empty-hint\">Carregando...</td></tr>";

    const query = start && end ? "?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end) : "";

    authorizedFetch("/api/admin/finance" + query)
      .then(function (result) {
        if (!result.ok) {
          return;
        }
        const data = result.body;
        financeTotalOrdersEl.textContent = data.totalOrders;
        financeTotalGmvEl.textContent = formatMoney(data.totalGmv);
        financeAvgTicketEl.textContent = formatMoney(data.avgTicket || 0);
        financeBodyEl.innerHTML = "";

        const byStore = data.byStore || [];

        if (!byStore.length) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = 4;
          cell.className = "admin-dash-empty-hint";
          cell.textContent = "Nenhum faturamento registrado nesse período.";
          row.appendChild(cell);
          financeBodyEl.appendChild(row);
          return;
        }

        byStore.forEach(function (store) {
          const row = document.createElement("tr");
          row.appendChild(makeCell(store.storeName || "-"));
          row.appendChild(makeCell(String(store.orders)));
          row.appendChild(makeCell(formatMoney(store.gmv), "is-money"));
          row.appendChild(makeCell(formatMoney(store.avgTicket || 0), "is-money"));
          financeBodyEl.appendChild(row);
        });
      })
      .catch(function () {});
  }

  if (financePeriodFormEl) {
    financePeriodFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      const start = financeStartInputEl.value;
      const end = financeEndInputEl.value;
      if (!start || !end) {
        loadFinance();
        return;
      }
      loadFinance(start, end);
    });
  }

  if (financePeriodClearEl) {
    financePeriodClearEl.addEventListener("click", function () {
      financeStartInputEl.value = "";
      financeEndInputEl.value = "";
      loadFinance();
    });
  }

  // -- Fechamento de período (comissão + repasse por loja) -------------------

  function formatDateOnly(value) {
    if (!value) {
      return "-";
    }
    return new Date(value).toLocaleDateString("pt-BR");
  }

  function loadCommissionSetting() {
    authorizedFetch("/api/admin/settings").then(function (result) {
      if (result.ok) {
        commissionThreshold1InputEl.value = result.body.threshold1;
        commissionThreshold2InputEl.value = result.body.threshold2;
        commissionRate1InputEl.value = result.body.rate1;
        commissionRate2InputEl.value = result.body.rate2;
        commissionRate3InputEl.value = result.body.rate3;
      }
    });
  }

  if (commissionFormEl) {
    commissionFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      commissionMessageEl.textContent = "Salvando...";

      authorizedFetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threshold1: Number(commissionThreshold1InputEl.value),
          threshold2: Number(commissionThreshold2InputEl.value),
          rate1: Number(commissionRate1InputEl.value),
          rate2: Number(commissionRate2InputEl.value),
          rate3: Number(commissionRate3InputEl.value)
        })
      }).then(function (result) {
        commissionMessageEl.textContent = result.ok
          ? "Faixas de comissão salvas."
          : (result.body && result.body.error) || "Não foi possível salvar.";
      });
    });
  }

  function loadTaxiPricing() {
    authorizedFetch("/api/admin/taxi-pricing").then(function (result) {
      if (!result.ok) {
        return;
      }
      var pricing = result.body.pricing;
      taxiPricingBaseInputEl.value = pricing.baseFare;
      taxiPricingKmInputEl.value = pricing.perKmRate;
      taxiPricingMinInputEl.value = pricing.perMinRate;
      taxiPricingMinimumInputEl.value = pricing.minimumFare;
    });
  }

  if (taxiPricingFormEl) {
    taxiPricingFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      taxiPricingMessageEl.textContent = "Salvando...";

      authorizedFetch("/api/admin/taxi-pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseFare: Number(taxiPricingBaseInputEl.value),
          perKmRate: Number(taxiPricingKmInputEl.value),
          perMinRate: Number(taxiPricingMinInputEl.value),
          minimumFare: Number(taxiPricingMinimumInputEl.value)
        })
      }).then(function (result) {
        taxiPricingMessageEl.textContent = result.ok
          ? "Valores salvos."
          : (result.body && result.body.error) || "Não foi possível salvar.";
      });
    });
  }

  function renderSettlementPreview(rows) {
    settlementPreviewBodyEl.innerHTML = "";

    if (!rows || !rows.length) {
      settlementPreviewWrapEl.hidden = true;
      settlementCloseActionsEl.hidden = true;
      settlementPreviewMessageEl.textContent =
        "Nenhum pedido entregue (e ainda não fechado) nesse período.";
      return;
    }

    settlementPreviewMessageEl.textContent = "";
    settlementPreviewWrapEl.hidden = false;
    settlementCloseActionsEl.hidden = false;

    rows.forEach(function (row) {
      const tr = document.createElement("tr");
      tr.appendChild(makeCell(row.storeName || row.storeId));
      tr.appendChild(makeCell(String(row.ordersCount)));
      tr.appendChild(makeCell(formatMoney(row.cashTotal), "is-money"));
      tr.appendChild(makeCell(formatMoney(row.onlineTotal), "is-money"));
      tr.appendChild(makeCell(formatMoney(row.commissionTotal), "is-money"));
      tr.appendChild(makeCell(formatMoney(row.netAmount), "is-money"));
      tr.appendChild(makeCell(formatMoney(row.balanceAfter), "is-money"));
      settlementPreviewBodyEl.appendChild(tr);
    });
  }

  if (settlementPreviewFormEl) {
    settlementPreviewFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      const start = settlementStartInputEl.value;
      const end = settlementEndInputEl.value;

      if (!start || !end) {
        return;
      }

      settlementPreviewMessageEl.textContent = "Calculando...";
      settlementPreviewWrapEl.hidden = true;
      settlementCloseActionsEl.hidden = true;

      authorizedFetch(
        "/api/admin/settlements/preview?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end)
      ).then(function (result) {
        if (!result.ok) {
          settlementPreviewMessageEl.textContent = (result.body && result.body.error) || "Não foi possível gerar a prévia.";
          return;
        }
        currentPreviewRange = { start: start, end: end };
        renderSettlementPreview(result.body.settlements);
      });
    });
  }

  if (settlementCloseButtonEl) {
    settlementCloseButtonEl.addEventListener("click", function () {
      if (!currentPreviewRange) {
        return;
      }

      const confirmed = window.confirm(
        "Fechar o período de " +
          formatDateOnly(currentPreviewRange.start) +
          " até " +
          formatDateOnly(currentPreviewRange.end) +
          "? Isso marca os pedidos como fechados (não entram de novo num próximo fechamento) e atualiza o saldo de cada loja."
      );

      if (!confirmed) {
        return;
      }

      settlementCloseButtonEl.disabled = true;

      authorizedFetch("/api/admin/settlements/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentPreviewRange)
      })
        .then(function (result) {
          settlementCloseButtonEl.disabled = false;

          if (!result.ok) {
            settlementPreviewMessageEl.textContent = (result.body && result.body.error) || "Não foi possível fechar o período.";
            return;
          }

          currentPreviewRange = null;
          settlementPreviewWrapEl.hidden = true;
          settlementCloseActionsEl.hidden = true;
          settlementPreviewMessageEl.textContent = "Período fechado com sucesso.";
          loadStoreBalances();
          loadSettlementsHistory();
        })
        .catch(function () {
          settlementCloseButtonEl.disabled = false;
        });
    });
  }

  function registerBalanceAdjustment(storeId, type) {
    const label = type === "payout" ? "repassado pra loja" : "recebido da loja";
    const amountText = window.prompt("Valor " + label + " (R$):");

    if (!amountText) {
      return;
    }

    const amount = Number(String(amountText).replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      window.alert("Valor inválido.");
      return;
    }

    const note = window.prompt("Observação (opcional):") || "";

    authorizedFetch("/api/admin/stores/" + encodeURIComponent(storeId) + "/balance-adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: type, amount: amount, note: note })
    }).then(function (result) {
      if (result.ok) {
        loadStoreBalances();
      } else {
        window.alert((result.body && result.body.error) || "Não foi possível registrar o ajuste.");
      }
    });
  }

  function loadStoreBalances() {
    storeBalancesBodyEl.innerHTML = "<tr><td colspan=\"3\" class=\"admin-dash-empty-hint\">Carregando...</td></tr>";

    authorizedFetch("/api/admin/store-balances").then(function (result) {
      if (!result.ok) {
        return;
      }

      const balances = result.body.balances || [];
      storeBalancesBodyEl.innerHTML = "";

      if (!balances.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 3;
        cell.className = "admin-dash-empty-hint";
        cell.textContent = "Nenhuma loja cadastrada ainda.";
        row.appendChild(cell);
        storeBalancesBodyEl.appendChild(row);
        return;
      }

      balances.forEach(function (item) {
        const row = document.createElement("tr");
        row.appendChild(makeCell(item.storeName || item.storeId));
        row.appendChild(makeCell(formatMoney(item.balance), "is-money"));

        const actionsCell = document.createElement("td");
        const payoutButton = document.createElement("button");
        payoutButton.type = "button";
        payoutButton.className = "admin-dash-small-button";
        payoutButton.textContent = "Registrar repasse";
        payoutButton.addEventListener("click", function () {
          registerBalanceAdjustment(item.storeId, "payout");
        });

        const collectionButton = document.createElement("button");
        collectionButton.type = "button";
        collectionButton.className = "admin-dash-small-button";
        collectionButton.textContent = "Registrar recebimento";
        collectionButton.addEventListener("click", function () {
          registerBalanceAdjustment(item.storeId, "collection");
        });

        actionsCell.appendChild(payoutButton);
        actionsCell.appendChild(collectionButton);
        row.appendChild(actionsCell);
        storeBalancesBodyEl.appendChild(row);
      });
    });
  }

  function loadSettlementsHistory() {
    settlementsHistoryBodyEl.innerHTML =
      "<tr><td colspan=\"5\" class=\"admin-dash-empty-hint\">Carregando...</td></tr>";

    authorizedFetch("/api/admin/settlements").then(function (result) {
      if (!result.ok) {
        return;
      }

      const settlements = result.body.settlements || [];
      settlementsHistoryBodyEl.innerHTML = "";

      if (!settlements.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 5;
        cell.className = "admin-dash-empty-hint";
        cell.textContent = "Nenhum fechamento feito ainda.";
        row.appendChild(cell);
        settlementsHistoryBodyEl.appendChild(row);
        return;
      }

      settlements.forEach(function (item) {
        const row = document.createElement("tr");
        row.appendChild(makeCell(item.storeName || item.storeId));
        row.appendChild(
          makeCell(formatDateOnly(item.periodStart) + " - " + formatDateOnly(item.periodEnd))
        );
        row.appendChild(makeCell(formatMoney(item.netAmount), "is-money"));
        row.appendChild(makeCell(formatMoney(item.balanceAfter), "is-money"));
        row.appendChild(makeCell(formatDateTime(item.createdAt)));
        settlementsHistoryBodyEl.appendChild(row);
      });
    });
  }

  // -- Comissão de taxista (mesma lógica do fechamento de lojas acima) ------

  function loadTaxiCommissionSetting() {
    authorizedFetch("/api/admin/taxi-commission").then(function (result) {
      if (result.ok) {
        taxiCommissionThreshold1InputEl.value = result.body.threshold1;
        taxiCommissionThreshold2InputEl.value = result.body.threshold2;
        taxiCommissionRate1InputEl.value = result.body.rate1;
        taxiCommissionRate2InputEl.value = result.body.rate2;
        taxiCommissionRate3InputEl.value = result.body.rate3;
      }
    });
  }

  if (taxiCommissionFormEl) {
    taxiCommissionFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      taxiCommissionMessageEl.textContent = "Salvando...";

      authorizedFetch("/api/admin/taxi-commission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threshold1: Number(taxiCommissionThreshold1InputEl.value),
          threshold2: Number(taxiCommissionThreshold2InputEl.value),
          rate1: Number(taxiCommissionRate1InputEl.value),
          rate2: Number(taxiCommissionRate2InputEl.value),
          rate3: Number(taxiCommissionRate3InputEl.value)
        })
      }).then(function (result) {
        taxiCommissionMessageEl.textContent = result.ok
          ? "Faixas de comissão salvas."
          : (result.body && result.body.error) || "Não foi possível salvar.";
      });
    });
  }

  function renderTaxiSettlementPreview(rows) {
    taxiSettlementPreviewBodyEl.innerHTML = "";

    if (!rows || !rows.length) {
      taxiSettlementPreviewWrapEl.hidden = true;
      taxiSettlementCloseActionsEl.hidden = true;
      taxiSettlementPreviewMessageEl.textContent =
        "Nenhuma corrida concluída (e ainda não fechada) nesse período.";
      return;
    }

    taxiSettlementPreviewMessageEl.textContent = "";
    taxiSettlementPreviewWrapEl.hidden = false;
    taxiSettlementCloseActionsEl.hidden = false;

    rows.forEach(function (row) {
      const tr = document.createElement("tr");
      tr.appendChild(makeCell(row.driverName || row.driverId));
      tr.appendChild(makeCell(String(row.ridesCount)));
      tr.appendChild(makeCell(formatMoney(row.cashTotal), "is-money"));
      tr.appendChild(makeCell(formatMoney(row.onlineTotal), "is-money"));
      tr.appendChild(makeCell(formatMoney(row.commissionTotal), "is-money"));
      tr.appendChild(makeCell(formatMoney(row.netAmount), "is-money"));
      tr.appendChild(makeCell(formatMoney(row.balanceAfter), "is-money"));
      taxiSettlementPreviewBodyEl.appendChild(tr);
    });
  }

  if (taxiSettlementPreviewFormEl) {
    taxiSettlementPreviewFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      const start = taxiSettlementStartInputEl.value;
      const end = taxiSettlementEndInputEl.value;

      if (!start || !end) {
        return;
      }

      taxiSettlementPreviewMessageEl.textContent = "Calculando...";
      taxiSettlementPreviewWrapEl.hidden = true;
      taxiSettlementCloseActionsEl.hidden = true;

      authorizedFetch(
        "/api/admin/taxi-settlements/preview?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end)
      ).then(function (result) {
        if (!result.ok) {
          taxiSettlementPreviewMessageEl.textContent = (result.body && result.body.error) || "Não foi possível gerar a prévia.";
          return;
        }
        currentTaxiPreviewRange = { start: start, end: end };
        renderTaxiSettlementPreview(result.body.settlements);
      });
    });
  }

  if (taxiSettlementCloseButtonEl) {
    taxiSettlementCloseButtonEl.addEventListener("click", function () {
      if (!currentTaxiPreviewRange) {
        return;
      }

      const confirmed = window.confirm(
        "Fechar o período de " +
          formatDateOnly(currentTaxiPreviewRange.start) +
          " até " +
          formatDateOnly(currentTaxiPreviewRange.end) +
          "? Isso marca as corridas como fechadas (não entram de novo num próximo fechamento) e atualiza o saldo de cada taxista."
      );

      if (!confirmed) {
        return;
      }

      taxiSettlementCloseButtonEl.disabled = true;

      authorizedFetch("/api/admin/taxi-settlements/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentTaxiPreviewRange)
      })
        .then(function (result) {
          taxiSettlementCloseButtonEl.disabled = false;

          if (!result.ok) {
            taxiSettlementPreviewMessageEl.textContent = (result.body && result.body.error) || "Não foi possível fechar o período.";
            return;
          }

          currentTaxiPreviewRange = null;
          taxiSettlementPreviewWrapEl.hidden = true;
          taxiSettlementCloseActionsEl.hidden = true;
          taxiSettlementPreviewMessageEl.textContent = "Período fechado com sucesso.";
          loadTaxiBalances();
          loadTaxiSettlementsHistory();
        })
        .catch(function () {
          taxiSettlementCloseButtonEl.disabled = false;
        });
    });
  }

  function registerTaxiBalanceAdjustment(driverId, type) {
    const label = type === "payout" ? "repassado pro taxista" : "recebido do taxista";
    const amountText = window.prompt("Valor " + label + " (R$):");

    if (!amountText) {
      return;
    }

    const amount = Number(String(amountText).replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      window.alert("Valor inválido.");
      return;
    }

    const note = window.prompt("Observação (opcional):") || "";

    authorizedFetch("/api/admin/taxi-drivers/" + encodeURIComponent(driverId) + "/balance-adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: type, amount: amount, note: note })
    }).then(function (result) {
      if (result.ok) {
        loadTaxiBalances();
      } else {
        window.alert((result.body && result.body.error) || "Não foi possível registrar o ajuste.");
      }
    });
  }

  function loadTaxiBalances() {
    taxiBalancesBodyEl.innerHTML = "<tr><td colspan=\"3\" class=\"admin-dash-empty-hint\">Carregando...</td></tr>";

    authorizedFetch("/api/admin/taxi-balances").then(function (result) {
      if (!result.ok) {
        return;
      }

      const balances = result.body.balances || [];
      taxiBalancesBodyEl.innerHTML = "";

      if (!balances.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 3;
        cell.className = "admin-dash-empty-hint";
        cell.textContent = "Nenhum taxista cadastrado ainda.";
        row.appendChild(cell);
        taxiBalancesBodyEl.appendChild(row);
        return;
      }

      balances.forEach(function (item) {
        const row = document.createElement("tr");
        row.appendChild(makeCell(item.driverName || item.driverId));
        row.appendChild(makeCell(formatMoney(item.balance), "is-money"));

        const actionsCell = document.createElement("td");
        const payoutButton = document.createElement("button");
        payoutButton.type = "button";
        payoutButton.className = "admin-dash-small-button";
        payoutButton.textContent = "Registrar repasse";
        payoutButton.addEventListener("click", function () {
          registerTaxiBalanceAdjustment(item.driverId, "payout");
        });

        const collectionButton = document.createElement("button");
        collectionButton.type = "button";
        collectionButton.className = "admin-dash-small-button";
        collectionButton.textContent = "Registrar recebimento";
        collectionButton.addEventListener("click", function () {
          registerTaxiBalanceAdjustment(item.driverId, "collection");
        });

        actionsCell.appendChild(payoutButton);
        actionsCell.appendChild(collectionButton);
        row.appendChild(actionsCell);
        taxiBalancesBodyEl.appendChild(row);
      });
    });
  }

  function loadTaxiSettlementsHistory() {
    taxiSettlementsHistoryBodyEl.innerHTML =
      "<tr><td colspan=\"5\" class=\"admin-dash-empty-hint\">Carregando...</td></tr>";

    authorizedFetch("/api/admin/taxi-settlements").then(function (result) {
      if (!result.ok) {
        return;
      }

      const settlements = result.body.settlements || [];
      taxiSettlementsHistoryBodyEl.innerHTML = "";

      if (!settlements.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 5;
        cell.className = "admin-dash-empty-hint";
        cell.textContent = "Nenhum fechamento feito ainda.";
        row.appendChild(cell);
        taxiSettlementsHistoryBodyEl.appendChild(row);
        return;
      }

      settlements.forEach(function (item) {
        const row = document.createElement("tr");
        row.appendChild(makeCell(item.driverName || item.driverId));
        row.appendChild(
          makeCell(formatDateOnly(item.periodStart) + " - " + formatDateOnly(item.periodEnd))
        );
        row.appendChild(makeCell(formatMoney(item.netAmount), "is-money"));
        row.appendChild(makeCell(formatMoney(item.balanceAfter), "is-money"));
        row.appendChild(makeCell(formatDateTime(item.createdAt)));
        taxiSettlementsHistoryBodyEl.appendChild(row);
      });
    });
  }

  // -- Estabelecimentos (criar loja + entrar como lojista) -------------------

  function loadCategories() {
    fetch("/api/catalog")
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        const categories = data.categories || [];
        categorySelectEl.innerHTML = "";
        chipCategoryInputEl.innerHTML = "";
        categories.forEach(function (category) {
          const option = document.createElement("option");
          option.value = category.id;
          option.textContent = `${category.icon || ""} ${category.name}`.trim();
          categorySelectEl.appendChild(option);

          const chipOption = option.cloneNode(true);
          chipCategoryInputEl.appendChild(chipOption);
        });
      })
      .catch(function () {
        // Sem categorias carregadas, o lojista ainda pode ajustar depois no
        // próprio painel dele.
      });
  }

  function loadStores() {
    setMessage(storesListMessageEl, "Carregando lojas...", "");
    storesListEl.innerHTML = "";

    fetch("/api/catalog")
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        const stores = data.stores || [];
        const categoriesById = {};
        (data.categories || []).forEach(function (category) {
          categoriesById[category.id] = category.name;
        });

        if (!stores.length) {
          setMessage(storesListMessageEl, "Nenhuma loja cadastrada ainda.", "");
          return;
        }

        setMessage(storesListMessageEl, "", "");

        stores.forEach(function (store) {
          const row = document.createElement("div");
          row.className = "admin-store-list-item";

          const info = document.createElement("div");
          info.className = "admin-store-list-info";
          const name = document.createElement("strong");
          name.textContent = store.name;
          const category = document.createElement("span");
          category.textContent = categoriesById[store.categoryId] || store.categoryId || "";
          info.appendChild(name);
          info.appendChild(category);

          const enterButton = document.createElement("button");
          enterButton.type = "button";
          enterButton.className = "secondary-button";
          enterButton.textContent = "Editar loja";
          enterButton.addEventListener("click", function () {
            enterStore(store.id, enterButton);
          });

          row.appendChild(info);
          row.appendChild(enterButton);
          storesListEl.appendChild(row);
        });
      })
      .catch(function () {
        setMessage(storesListMessageEl, "Erro ao carregar as lojas.", "error");
      });
  }

  function enterStore(storeId, buttonEl) {
    buttonEl.disabled = true;

    fetch("/api/admin/impersonate-store", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ storeId })
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, status: response.status, body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          buttonEl.disabled = false;
          if (result.status === 401) {
            setMessage(storesListMessageEl, "Sua sessão expirou. Faca login de novo.", "error");
            showLogin();
            return;
          }
          setMessage(storesListMessageEl, result.body.error || "Não foi possível entrar nessa loja.", "error");
          return;
        }

        const session = {
          ownerId: result.body.owner.id,
          ownerName: result.body.owner.ownerName,
          storeId: result.body.owner.storeId,
          storeName: result.body.owner.storeName,
          username: result.body.owner.username,
          token: result.body.token,
          // Marca que essa sessão veio de "Entrar como lojista" no painel
          // admin, pra admin.html mostrar o aviso de edição como admin.
          viaAdmin: true
        };

        window.localStorage.setItem(OWNER_SESSION_KEY, JSON.stringify(session));
        window.location.href = "./admin.html";
      })
      .catch(function () {
        buttonEl.disabled = false;
        setMessage(storesListMessageEl, "Erro de conexão com o servidor.", "error");
      });
  }

  // -- Ícones da Home (banco home_chips) -------------------------------------

  function populateChipParentOptions(chips) {
    const currentValue = chipParentInputEl.value;
    chipParentInputEl.innerHTML = "";

    const rootOption = document.createElement("option");
    rootOption.value = "";
    rootOption.textContent = "Ícone principal (direto na Home)";
    chipParentInputEl.appendChild(rootOption);

    chips
      .filter(function (chip) {
        return !chip.parentId && chip.kind === "group" && chip.id !== editingChipId;
      })
      .forEach(function (chip) {
        const option = document.createElement("option");
        option.value = chip.id;
        option.textContent = "Dentro de " + chip.label;
        chipParentInputEl.appendChild(option);
      });

    if (Array.prototype.some.call(chipParentInputEl.options, function (opt) {
      return opt.value === currentValue;
    })) {
      chipParentInputEl.value = currentValue;
    }

    updateChipFormVisibility();
  }

  function updateChipFormVisibility() {
    const isChild = !!chipParentInputEl.value;
    chipKindFieldEl.hidden = isChild;
    if (isChild) {
      chipKindInputEl.value = "link";
    }

    const isLink = chipKindInputEl.value === "link";
    chipCategoryFieldEl.hidden = !isLink;
    chipSubCategoryFieldEl.hidden = !isLink;
    chipSearchFieldEl.hidden = !isLink;
  }

  function loadChips() {
    setMessage(chipsListMessageEl, "Carregando ícones...", "");
    chipsListEl.innerHTML = "";

    fetch("/api/home-chips")
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        chipsCache = data.chips || [];
        populateChipParentOptions(chipsCache);
        renderChipsList(chipsCache);
      })
      .catch(function () {
        setMessage(chipsListMessageEl, "Erro ao carregar os ícones.", "error");
      });
  }

  function renderChipsList(chips) {
    chipsListEl.innerHTML = "";

    const roots = chips
      .filter(function (chip) {
        return !chip.parentId;
      })
      .sort(function (a, b) {
        return (a.sortOrder || 0) - (b.sortOrder || 0);
      });

    if (!roots.length) {
      setMessage(chipsListMessageEl, "Nenhum ícone cadastrado ainda.", "");
      return;
    }

    setMessage(chipsListMessageEl, "", "");

    roots.forEach(function (chip) {
      chipsListEl.appendChild(buildChipRow(chip, false));

      chips
        .filter(function (child) {
          return child.parentId === chip.id;
        })
        .sort(function (a, b) {
          return (a.sortOrder || 0) - (b.sortOrder || 0);
        })
        .forEach(function (child) {
          chipsListEl.appendChild(buildChipRow(child, true));
        });
    });
  }

  function buildChipRow(chip, isChild) {
    const row = document.createElement("div");
    row.className = "admin-store-list-item" + (isChild ? " admin-chip-child" : "");

    const info = document.createElement("div");
    info.className = "admin-store-list-info";
    const name = document.createElement("strong");
    name.textContent = (isChild ? "↳ " : "") + chip.label;
    const meta = document.createElement("span");
    meta.textContent =
      chip.kind === "group"
        ? "Grupo de sub-ícones · fa " + chip.icon
        : "fa " + chip.icon + (chip.categoryId ? " · categoria: " + chip.categoryId : "");
    info.appendChild(name);
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "admin-chip-actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "secondary-button";
    editButton.textContent = "Editar";
    editButton.addEventListener("click", function () {
      openChipEditForm(chip);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "secondary-button admin-chip-delete";
    deleteButton.textContent = "Excluir";
    deleteButton.addEventListener("click", function () {
      const warning =
        chip.kind === "group"
          ? `Excluir o ícone "${chip.label}"? Os sub-ícones dele também serão excluídos.`
          : `Excluir o ícone "${chip.label}"?`;
      if (!window.confirm(warning)) {
        return;
      }
      deleteChip(chip.id);
    });

    actions.appendChild(editButton);
    actions.appendChild(deleteButton);

    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  function openChipEditForm(chip) {
    editingChipId = chip.id;
    chipLabelInputEl.value = chip.label || "";
    chipIconInputEl.value = chip.icon || "";
    chipKindInputEl.value = chip.kind === "group" ? "group" : "link";
    chipCategoryInputEl.value = chip.categoryId || "";
    chipSubCategoryInputEl.value = chip.subCategory || "";
    chipSearchInputEl.value = chip.searchTerm || "";

    populateChipParentOptions(chipsCache);
    chipParentInputEl.value = chip.parentId || "";
    updateChipFormVisibility();

    chipSubmitButtonEl.textContent = "Salvar alterações";
    chipCancelEditButtonEl.hidden = false;
    setMessage(createChipMessageEl, "", "");
    createChipFormEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelChipEdit() {
    editingChipId = "";
    createChipFormEl.reset();
    populateChipParentOptions(chipsCache);
    updateChipFormVisibility();
    chipSubmitButtonEl.textContent = "Criar ícone";
    chipCancelEditButtonEl.hidden = true;
  }

  function deleteChip(chipId) {
    authorizedFetch("/api/admin/home-chips/" + encodeURIComponent(chipId), {
      method: "DELETE"
    })
      .then(function (result) {
        if (!result.ok) {
          setMessage(chipsListMessageEl, result.body.error || "Não foi possível excluir o ícone.", "error");
          return;
        }
        chipsCache = result.body.chips || [];
        if (editingChipId === chipId) {
          cancelChipEdit();
        } else {
          populateChipParentOptions(chipsCache);
        }
        renderChipsList(chipsCache);
      })
      .catch(function () {
        setMessage(chipsListMessageEl, "Erro de conexão com o servidor.", "error");
      });
  }

  chipParentInputEl.addEventListener("change", updateChipFormVisibility);
  chipKindInputEl.addEventListener("change", updateChipFormVisibility);

  chipCancelEditButtonEl.addEventListener("click", function () {
    cancelChipEdit();
  });

  createChipFormEl.addEventListener("submit", function (event) {
    event.preventDefault();
    setMessage(createChipMessageEl, "", "");

    const parentId = chipParentInputEl.value;
    const kind = parentId ? "link" : chipKindInputEl.value;

    const payload = {
      label: chipLabelInputEl.value.trim(),
      icon: chipIconInputEl.value.trim(),
      parentId: parentId,
      kind: kind,
      categoryId: chipCategoryInputEl.value,
      subCategory: chipSubCategoryInputEl.value.trim(),
      searchTerm: chipSearchInputEl.value.trim()
    };

    if (!payload.label || !payload.icon) {
      setMessage(createChipMessageEl, "Preencha o nome e o ícone.", "error");
      return;
    }

    if (kind === "link" && !payload.categoryId) {
      setMessage(createChipMessageEl, "Escolha a categoria pra onde esse ícone leva.", "error");
      return;
    }

    const isEditing = !!editingChipId;
    const path = isEditing
      ? "/api/admin/home-chips/" + encodeURIComponent(editingChipId)
      : "/api/admin/home-chips";

    authorizedFetch(path, {
      method: isEditing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (result) {
        if (!result.ok) {
          setMessage(createChipMessageEl, result.body.error || "Não foi possível salvar o ícone.", "error");
          return;
        }
        chipsCache = result.body.chips || [];
        renderChipsList(chipsCache);
        const wasEditing = isEditing;
        cancelChipEdit();
        setMessage(createChipMessageEl, wasEditing ? "Ícone atualizado!" : "Ícone criado!", "success");
      })
      .catch(function (err) {
        if (err && err.message === "unauthorized") {
          return;
        }
        setMessage(createChipMessageEl, "Erro de conexão com o servidor.", "error");
      });
  });

  loginFormEl.addEventListener("submit", function (event) {
    event.preventDefault();
    setMessage(loginMessageEl, "", "");

    const username = usernameInputEl.value.trim();
    const password = passwordInputEl.value;

    if (!username || !password) {
      setMessage(loginMessageEl, "Preencha usuário e senha.", "error");
      return;
    }

    fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          setMessage(loginMessageEl, result.body.error || "Não foi possível entrar.", "error");
          return;
        }
        adminToken = result.body.token;
        adminUsername = username;
        showPanel();
      })
      .catch(function () {
        setMessage(loginMessageEl, "Erro de conexão com o servidor.", "error");
      });
  });

  createStoreFormEl.addEventListener("submit", function (event) {
    event.preventDefault();
    setMessage(createStoreMessageEl, "", "");

    const payload = {
      storeName: document.getElementById("store-name-input").value.trim(),
      categoryId: categorySelectEl.value,
      ownerName: document.getElementById("owner-name-input").value.trim(),
      username: document.getElementById("username-input").value.trim(),
      ownerEmail: document.getElementById("create-store-owner-email-input").value.trim(),
      description: document.getElementById("store-description-input").value.trim(),
      deliveryTime: document.getElementById("delivery-time-input").value.trim(),
      deliveryFee: document.getElementById("delivery-fee-input").value.trim(),
      minOrder: document.getElementById("min-order-input").value,
      openingHours: document.getElementById("opening-hours-input").value.trim(),
      priceRange: document.getElementById("price-range-input").value
    };

    if (!payload.storeName || !payload.categoryId || !payload.ownerName) {
      setMessage(createStoreMessageEl, "Preencha nome da loja, categoria e nome do responsável.", "error");
      return;
    }

    fetch("/api/admin/stores", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, status: response.status, body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          if (result.status === 401) {
            setMessage(createStoreMessageEl, "Sua sessão expirou. Faca login de novo.", "error");
            showLogin();
            return;
          }
          setMessage(createStoreMessageEl, result.body.error || "Não foi possível criar a loja.", "error");
          return;
        }

        credentialsUsernameEl.textContent = result.body.credentials.username;
        credentialsPasswordEl.textContent = result.body.credentials.password;
        createStoreFormEl.hidden = true;
        credentialsCardEl.hidden = false;
        loadStores();
      })
      .catch(function () {
        setMessage(createStoreMessageEl, "Erro de conexão com o servidor.", "error");
      });
  });

  createAnotherButtonEl.addEventListener("click", function () {
    createStoreFormEl.reset();
    createStoreFormEl.hidden = false;
    credentialsCardEl.hidden = true;
    setMessage(createStoreMessageEl, "", "");
  });

  // -- Taxistas ---------------------------------------------------------

  // Documentos (CNH, CRLV, antecedentes) não têm URL pública - precisam do
  // token de admin no header, então baixamos como blob autenticado e
  // abrimos numa aba nova, em vez de usar um <a href> comum.
  function openAdminDocument(url, buttonEl) {
    const originalLabel = buttonEl.textContent;
    buttonEl.disabled = true;
    buttonEl.textContent = "Abrindo...";

    fetch(url, { headers: { Authorization: "Bearer " + adminToken } })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("document-fetch-failed");
        }
        return response.blob();
      })
      .then(function (blob) {
        const objectUrl = URL.createObjectURL(blob);
        window.open(objectUrl, "_blank");
      })
      .catch(function () {
        window.alert("Não foi possível abrir esse documento.");
      })
      .finally(function () {
        buttonEl.disabled = false;
        buttonEl.textContent = originalLabel;
      });
  }

  function makeDocButton(label, url) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.textContent = label;
    button.addEventListener("click", function () {
      openAdminDocument(url, button);
    });
    return button;
  }

  const TAXI_VERIFICATION_LABELS = {
    pendente: ["Pendente", "status-pill-pending"],
    aprovado: ["Aprovado", "status-pill"],
    recusado: ["Recusado", "status-pill-danger"]
  };

  function loadTaxiDrivers() {
    setMessage(taxiDriversListMessageEl, "Carregando taxistas...", "");
    taxiDriversListEl.innerHTML = "";

    authorizedFetch("/api/admin/taxi-drivers")
      .then(function (result) {
        if (!result.ok) {
          setMessage(taxiDriversListMessageEl, result.body.error || "Não foi possível carregar os taxistas.", "error");
          return;
        }

        const drivers = result.body.drivers || [];

        if (!drivers.length) {
          setMessage(taxiDriversListMessageEl, "Nenhum taxista cadastrado ainda.", "");
          return;
        }

        setMessage(taxiDriversListMessageEl, "", "");

        drivers.forEach(function (driver) {
          taxiDriversListEl.appendChild(renderTaxiDriverCard(driver));
        });
      })
      .catch(function () {
        setMessage(taxiDriversListMessageEl, "Erro ao carregar os taxistas.", "error");
      });
  }

  function renderTaxiDriverCard(driver) {
    const card = document.createElement("div");
    card.className = "admin-verify-card";

    const head = document.createElement("div");
    head.className = "admin-verify-card-head";

    const nameEl = document.createElement("strong");
    nameEl.textContent = driver.name || "-";

    const statusInfo = TAXI_VERIFICATION_LABELS[driver.verificationStatus] || TAXI_VERIFICATION_LABELS.pendente;
    const statusEl = document.createElement("span");
    statusEl.className = "status-pill " + statusInfo[1];
    statusEl.textContent = statusInfo[0] + " · " + (driver.isOnline ? "Online" : "Offline");

    head.appendChild(nameEl);
    head.appendChild(statusEl);

    const meta = document.createElement("div");
    meta.className = "admin-verify-meta";
    meta.innerHTML =
      "<span>Usuário: " + (driver.username || "-") + " · Telefone: " + (driver.phone || "-") + "</span>" +
      "<span>Veículo: " + (driver.vehicle || "-") + " · CPF: " + (driver.cpf || "-") + "</span>" +
      "<span>CNH: " + (driver.cnhNumber || "-") + " · Categoria " + (driver.cnhCategory || "-") +
      " · Validade " + (driver.cnhExpiresAt ? formatDateTime(driver.cnhExpiresAt).split(" ")[0] : "-") +
      " · EAR: " + (driver.cnhHasEar ? "Sim" : "Não") +
      " · " + (driver.cnhType === "digital" ? "CNH digital (app Vio)" : "CNH física") + "</span>";

    if (driver.verificationNote) {
      const note = document.createElement("div");
      note.className = "admin-verify-note";
      note.textContent = "Observação: " + driver.verificationNote;
      meta.appendChild(note);
    }

    const docs = document.createElement("div");
    docs.className = "admin-verify-docs";
    const docBase = "/api/admin/taxi-drivers/" + encodeURIComponent(driver.id) + "/documents/";
    if (driver.hasCnhDigital) {
      docs.appendChild(makeDocButton("CNH digital (PDF)", docBase + "cnh-digital"));
    }
    if (driver.hasCnhFront) {
      docs.appendChild(makeDocButton("CNH (frente)", docBase + "cnh-front"));
    }
    if (driver.hasCnhBack) {
      docs.appendChild(makeDocButton("CNH (verso)", docBase + "cnh-back"));
    }
    if (driver.hasCrlv) {
      docs.appendChild(makeDocButton("CRLV", docBase + "crlv"));
    }
    if (driver.hasCriminalRecord) {
      docs.appendChild(makeDocButton("Antecedentes", docBase + "criminal-record"));
    }
    if (driver.hasCnhDigital) {
      const vioHint = document.createElement("span");
      vioHint.className = "admin-verify-note";
      vioHint.textContent = "Dica: abra o PDF e escaneie o QR Code com o app Vio pra confirmar que é autêntico.";
      docs.appendChild(vioHint);
    }
    if (!docs.children.length) {
      const noDocs = document.createElement("span");
      noDocs.className = "admin-verify-note";
      noDocs.textContent = "Nenhum documento enviado (cadastrado direto pelo admin).";
      docs.appendChild(noDocs);
    }

    const actions = document.createElement("div");
    actions.className = "admin-verify-actions";

    if (driver.verificationStatus !== "aprovado") {
      const approveButton = document.createElement("button");
      approveButton.type = "button";
      approveButton.className = "primary-button";
      approveButton.textContent = "Aprovar";
      approveButton.addEventListener("click", function () {
        verifyTaxiDriver(driver.id, "aprovado", "", approveButton);
      });
      actions.appendChild(approveButton);
    }

    if (driver.verificationStatus !== "recusado") {
      const rejectButton = document.createElement("button");
      rejectButton.type = "button";
      rejectButton.className = "secondary-button";
      rejectButton.textContent = "Recusar";
      rejectButton.addEventListener("click", function () {
        const note = window.prompt("Motivo da recusa (opcional, o taxista não vê isso ainda):", "");
        if (note === null) {
          return;
        }
        verifyTaxiDriver(driver.id, "recusado", note, rejectButton);
      });
      actions.appendChild(rejectButton);
    }

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "secondary-button";
    editButton.textContent = "Editar dados";
    editButton.addEventListener("click", function () {
      const isOpen = editForm.hidden === false;
      editForm.hidden = isOpen;
      editButton.textContent = isOpen ? "Editar dados" : "Cancelar edição";
    });
    actions.appendChild(editButton);

    const editForm = buildTaxiDriverEditForm(driver, editButton);

    card.appendChild(head);
    card.appendChild(meta);
    card.appendChild(docs);
    card.appendChild(actions);
    card.appendChild(editForm);
    return card;
  }

  // Formulário inline (some/aparece) pra editar nome, telefone, veículo/placa
  // e e-mail de um taxista já cadastrado. Não mexe em usuário nem senha - a
  // senha só muda pela tela de login, com "Esqueci minha senha".
  function buildTaxiDriverEditForm(driver, editButton) {
    const form = document.createElement("form");
    form.className = "admin-verify-edit-form";
    form.hidden = true;

    const vehicleParts = splitVehicleAndPlate(driver.vehicle || "");

    function makeInput(labelText, value, placeholder, type) {
      const label = document.createElement("label");
      label.className = "field";
      const span = document.createElement("span");
      span.textContent = labelText;
      const input = document.createElement("input");
      input.type = type || "text";
      input.value = value || "";
      if (placeholder) {
        input.placeholder = placeholder;
      }
      label.appendChild(span);
      label.appendChild(input);
      form.appendChild(label);
      return input;
    }

    const nameInput = makeInput("Nome", driver.name);
    const phoneInput = makeInput("Telefone", driver.phone, "Ex.: (41) 99999-9999");
    const vehicleInput = makeInput("Veículo", vehicleParts.vehicle, "Ex.: Corolla prata");
    const plateInput = makeInput("Placa", vehicleParts.plate, "Ex.: ABC1234");
    const emailInput = makeInput("E-mail de recuperação", driver.email, "Pra ele usar o Esqueci minha senha", "email");

    const actionsRow = document.createElement("div");
    actionsRow.className = "checkout-actions";
    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "primary-button";
    saveButton.textContent = "Salvar alterações";
    actionsRow.appendChild(saveButton);
    form.appendChild(actionsRow);

    const messageEl = document.createElement("div");
    messageEl.className = "inline-message";
    form.appendChild(messageEl);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const name = nameInput.value.trim();
      const phone = phoneInput.value.trim();
      const vehicle = vehicleInput.value.trim();
      const plate = plateInput.value.trim();
      const email = emailInput.value.trim();

      if (!name || !phone) {
        setMessage(messageEl, "Nome e telefone não podem ficar em branco.", "error");
        return;
      }

      saveButton.disabled = true;
      authorizedFetch("/api/admin/taxi-drivers/" + encodeURIComponent(driver.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phone,
          vehicle: plate ? vehicle + " - " + plate : vehicle,
          email
        })
      })
        .then(function (result) {
          if (!result.ok) {
            saveButton.disabled = false;
            setMessage(messageEl, result.body.error || "Não foi possível salvar as alterações.", "error");
            return;
          }
          loadTaxiDrivers();
        })
        .catch(function () {
          saveButton.disabled = false;
          setMessage(messageEl, "Erro de conexão com o servidor.", "error");
        });
    });

    return form;
  }

  // Tenta separar "Corolla prata - ABC1234" de volta em veículo + placa pra
  // pré-preencher o formulário de edição - taxistas cadastrados antes desse
  // campo existir podem não ter esse padrão, então cai tudo em "vehicle" se
  // não achar o separador.
  function splitVehicleAndPlate(vehicleText) {
    const separatorIndex = vehicleText.lastIndexOf(" - ");
    if (separatorIndex < 0) {
      return { vehicle: vehicleText, plate: "" };
    }
    return {
      vehicle: vehicleText.slice(0, separatorIndex),
      plate: vehicleText.slice(separatorIndex + 3)
    };
  }

  function verifyTaxiDriver(driverId, status, note, buttonEl) {
    buttonEl.disabled = true;

    authorizedFetch("/api/admin/taxi-drivers/" + encodeURIComponent(driverId) + "/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, note })
    })
      .then(function (result) {
        if (!result.ok) {
          buttonEl.disabled = false;
          setMessage(taxiDriversListMessageEl, result.body.error || "Não foi possível atualizar o taxista.", "error");
          return;
        }
        loadTaxiDrivers();
      })
      .catch(function () {
        buttonEl.disabled = false;
        setMessage(taxiDriversListMessageEl, "Erro de conexão com o servidor.", "error");
      });
  }

  // -- Prestadores --------------------------------------------------------

  function loadProviders() {
    setMessage(providersListMessageEl, "Carregando prestadores...", "");
    providersListEl.innerHTML = "";

    authorizedFetch("/api/admin/providers")
      .then(function (result) {
        if (!result.ok) {
          setMessage(providersListMessageEl, result.body.error || "Não foi possível carregar os prestadores.", "error");
          return;
        }

        const providers = result.body.providers || [];

        if (!providers.length) {
          setMessage(providersListMessageEl, "Nenhum prestador cadastrado ainda.", "");
          return;
        }

        setMessage(providersListMessageEl, "", "");

        providers.forEach(function (provider) {
          providersListEl.appendChild(renderProviderCard(provider));
        });
      })
      .catch(function () {
        setMessage(providersListMessageEl, "Erro ao carregar os prestadores.", "error");
      });
  }

  function loadProviderVisitCommission() {
    if (!providerVisitCommissionInputEl) {
      return;
    }
    authorizedFetch("/api/admin/provider-visit-commission")
      .then(function (result) {
        if (!result.ok) {
          return;
        }
        if (document.activeElement !== providerVisitCommissionInputEl) {
          providerVisitCommissionInputEl.value = result.body.rate;
        }
      })
      .catch(function () {});
  }

  if (providerVisitCommissionFormEl) {
    providerVisitCommissionFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      const rate = Number(providerVisitCommissionInputEl.value);

      if (!(rate >= 0) || !(rate <= 100)) {
        setMessage(providerVisitCommissionMessageEl, "Informe uma taxa entre 0 e 100.", "error");
        return;
      }

      setMessage(providerVisitCommissionMessageEl, "Salvando...", "");

      authorizedFetch("/api/admin/provider-visit-commission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate: rate })
      })
        .then(function (result) {
          if (!result.ok) {
            setMessage(providerVisitCommissionMessageEl, result.body.error || "Não foi possível salvar.", "error");
            return;
          }
          setMessage(providerVisitCommissionMessageEl, "Salvo!", "success");
        })
        .catch(function () {
          setMessage(providerVisitCommissionMessageEl, "Erro de conexão com o servidor.", "error");
        });
    });
  }

  function escapeReviewHtml(text) {
    const div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  function loadProviderReviews() {
    if (!providerReviewsListEl) {
      return;
    }
    providerReviewsListEl.innerHTML = '<div class="admin-dash-empty-hint">Carregando...</div>';

    authorizedFetch("/api/admin/provider-reviews")
      .then(function (result) {
        if (!result.ok) {
          providerReviewsListEl.innerHTML = "";
          return;
        }

        const reviews = result.body.reviews || [];

        if (!reviews.length) {
          providerReviewsListEl.innerHTML = '<div class="admin-dash-empty-hint">Nenhuma avaliação recebida ainda.</div>';
          return;
        }

        providerReviewsListEl.innerHTML = "";
        reviews.forEach(function (review) {
          const card = document.createElement("div");
          card.className = "admin-verify-card";
          const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
          card.innerHTML =
            '<div class="admin-verify-card-head"><strong>' +
            escapeReviewHtml(review.providerName || "-") +
            '</strong><span class="status-pill">' +
            stars +
            "</span></div>" +
            '<div class="admin-verify-meta"><span>Cliente: ' +
            escapeReviewHtml(review.customerName || "-") +
            " · " +
            new Date(review.createdAt).toLocaleDateString("pt-BR") +
            "</span></div>" +
            (review.comment ? '<p class="muted-copy">"' + escapeReviewHtml(review.comment) + '"</p>' : "");
          providerReviewsListEl.appendChild(card);
        });
      })
      .catch(function () {
        providerReviewsListEl.innerHTML = "";
      });
  }

  function renderProviderCard(provider) {
    const card = document.createElement("div");
    card.className = "admin-verify-card";

    const head = document.createElement("div");
    head.className = "admin-verify-card-head";

    const nameEl = document.createElement("strong");
    nameEl.textContent = provider.name || "-";

    const statusEl = document.createElement("span");
    if (!provider.hasCriminalRecord) {
      statusEl.className = "status-pill status-pill-pending";
      statusEl.textContent = "Sem certidão enviada";
    } else if (provider.criminalRecordVerified) {
      statusEl.className = "status-pill";
      statusEl.textContent = "Antecedentes verificados";
    } else {
      statusEl.className = "status-pill status-pill-pending";
      statusEl.textContent = "Certidão enviada · aguardando conferência";
    }

    head.appendChild(nameEl);
    head.appendChild(statusEl);

    const meta = document.createElement("div");
    meta.className = "admin-verify-meta";
    meta.innerHTML =
      "<span>Usuário: " + (provider.username || "-") + " · Telefone: " + (provider.phone || "-") + "</span>" +
      "<span>Especialidade: " + (provider.specialty || "-") + " · CPF: " + (provider.cpf || "-") + "</span>";

    const docs = document.createElement("div");
    docs.className = "admin-verify-docs";
    if (provider.hasCriminalRecord) {
      docs.appendChild(
        makeDocButton(
          "Ver certidão",
          "/api/admin/providers/" + encodeURIComponent(provider.id) + "/documents/criminal-record"
        )
      );
    }

    const actions = document.createElement("div");
    actions.className = "admin-verify-actions";

    if (provider.hasCriminalRecord) {
      const toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.className = provider.criminalRecordVerified ? "secondary-button" : "primary-button";
      toggleButton.textContent = provider.criminalRecordVerified ? "Remover selo de verificado" : "Marcar como verificado";
      toggleButton.addEventListener("click", function () {
        verifyProviderCriminalRecord(provider.id, !provider.criminalRecordVerified, toggleButton);
      });
      actions.appendChild(toggleButton);
    }

    card.appendChild(head);
    card.appendChild(meta);
    if (docs.children.length) {
      card.appendChild(docs);
    }
    if (actions.children.length) {
      card.appendChild(actions);
    }
    return card;
  }

  function verifyProviderCriminalRecord(providerId, verified, buttonEl) {
    buttonEl.disabled = true;

    authorizedFetch("/api/admin/providers/" + encodeURIComponent(providerId) + "/verify-antecedentes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verified })
    })
      .then(function (result) {
        if (!result.ok) {
          buttonEl.disabled = false;
          setMessage(providersListMessageEl, result.body.error || "Não foi possível atualizar o prestador.", "error");
          return;
        }
        loadProviders();
      })
      .catch(function () {
        buttonEl.disabled = false;
        setMessage(providersListMessageEl, "Erro de conexão com o servidor.", "error");
      });
  }

  // -- Diagnóstico de pagamentos ----------------------------------------

  function loadPaymentErrors() {
    setMessage(paymentErrorsListMessageEl, "Carregando...", "");
    paymentErrorsListBodyEl.innerHTML = "";

    authorizedFetch("/api/admin/payment-errors")
      .then(function (result) {
        if (!result.ok) {
          setMessage(paymentErrorsListMessageEl, result.body.error || "Não foi possível carregar.", "error");
          return;
        }

        const errors = result.body.errors || [];

        if (!errors.length) {
          setMessage(paymentErrorsListMessageEl, "Nenhuma falha de pagamento registrada ainda. Bom sinal.", "");
          return;
        }

        setMessage(paymentErrorsListMessageEl, "", "");

        errors.forEach(function (item) {
          const row = document.createElement("tr");
          row.appendChild(makeCell(formatDateTime(item.createdAt)));
          row.appendChild(makeCell(item.kind || "-"));
          row.appendChild(makeCell(shortOrderId(item.orderId)));
          row.appendChild(makeCell(item.httpStatus != null ? String(item.httpStatus) : "-"));
          row.appendChild(makeCell(item.message || item.rawResponse || "-"));
          paymentErrorsListBodyEl.appendChild(row);
        });
      })
      .catch(function () {
        setMessage(paymentErrorsListMessageEl, "Erro ao carregar as falhas de pagamento.", "error");
      });
  }

  // -- Notificações de marketing -----------------------------------------

  const marketingPushFormEl = document.getElementById("marketing-push-form");
  const marketingPushTitleEl = document.getElementById("marketing-push-title");
  const marketingPushBodyEl = document.getElementById("marketing-push-body");
  const marketingPushUrlEl = document.getElementById("marketing-push-url");
  const marketingPushMessageEl = document.getElementById("marketing-push-message");
  const marketingHistoryMessageEl = document.getElementById("marketing-history-message");
  const marketingHistoryBodyEl = document.getElementById("marketing-history-body");

  function loadMarketingHistory() {
    setMessage(marketingHistoryMessageEl, "Carregando...", "");
    marketingHistoryBodyEl.innerHTML = "";

    authorizedFetch("/api/admin/push/broadcasts")
      .then(function (result) {
        if (!result.ok) {
          setMessage(marketingHistoryMessageEl, result.body.error || "Não foi possível carregar.", "error");
          return;
        }

        const broadcasts = result.body.broadcasts || [];

        if (!broadcasts.length) {
          setMessage(marketingHistoryMessageEl, "Nenhuma notificação enviada ainda.", "");
          return;
        }

        setMessage(marketingHistoryMessageEl, "", "");

        broadcasts.forEach(function (item) {
          const row = document.createElement("tr");
          row.appendChild(makeCell(formatDateTime(item.createdAt)));
          row.appendChild(makeCell(item.title || "-"));
          row.appendChild(makeCell(item.body || "-"));
          row.appendChild(makeCell(String(item.recipientsCount || 0)));
          marketingHistoryBodyEl.appendChild(row);
        });
      })
      .catch(function () {
        setMessage(marketingHistoryMessageEl, "Erro ao carregar o histórico.", "error");
      });
  }

  if (marketingPushFormEl) {
    marketingPushFormEl.addEventListener("submit", function (event) {
      event.preventDefault();

      const title = marketingPushTitleEl.value.trim();
      const body = marketingPushBodyEl.value.trim();
      const url = marketingPushUrlEl.value.trim();

      if (!title || !body) {
        setMessage(marketingPushMessageEl, "Preencha o título e a mensagem.", "error");
        return;
      }

      const confirmed = window.confirm(
        'Enviar "' + title + '" para TODOS os clientes que ativaram notificações? Essa ação não pode ser desfeita.'
      );
      if (!confirmed) {
        return;
      }

      setMessage(marketingPushMessageEl, "Enviando...", "");

      authorizedFetch("/api/admin/push/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, url })
      })
        .then(function (result) {
          if (!result.ok) {
            setMessage(marketingPushMessageEl, result.body.error || "Não foi possível enviar.", "error");
            return;
          }
          setMessage(marketingPushMessageEl, result.body.message || "Enviado.", "success");
          marketingPushFormEl.reset();
          loadMarketingHistory();
        })
        .catch(function () {
          setMessage(marketingPushMessageEl, "Erro ao enviar a notificação.", "error");
        });
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ""));
      };
      reader.onerror = function () {
        reject(new Error("Não foi possível ler o arquivo."));
      };
      reader.readAsDataURL(file);
    });
  }

  const taxiDriverCrlvInputEl = document.getElementById("taxi-driver-crlv-input");
  const taxiDriverCrlvStatusEl = document.getElementById("taxi-driver-crlv-status");

  if (taxiDriverCrlvInputEl) {
    taxiDriverCrlvInputEl.addEventListener("change", function () {
      const file = taxiDriverCrlvInputEl.files && taxiDriverCrlvInputEl.files[0];
      taxiDriverCrlvStatusEl.textContent = file ? file.name : "Nenhum arquivo selecionado.";
    });
  }

  createTaxiDriverFormEl.addEventListener("submit", async function (event) {
    event.preventDefault();
    setMessage(createTaxiDriverMessageEl, "", "");

    const vehicle = document.getElementById("taxi-driver-vehicle-input").value.trim();
    const plate = document.getElementById("taxi-driver-plate-input").value.trim();

    const payload = {
      name: document.getElementById("taxi-driver-name-input").value.trim(),
      phone: document.getElementById("taxi-driver-phone-input").value.trim(),
      vehicle: plate ? vehicle + " - " + plate : vehicle,
      username: document.getElementById("taxi-driver-username-input").value.trim(),
      password: document.getElementById("taxi-driver-password-input").value.trim(),
      email: document.getElementById("taxi-driver-email-input").value.trim()
    };

    if (!payload.name || !payload.phone) {
      setMessage(createTaxiDriverMessageEl, "Preencha nome e telefone do taxista.", "error");
      return;
    }

    if (payload.password && payload.password.length < 6) {
      setMessage(createTaxiDriverMessageEl, "A senha deve ter pelo menos 6 caracteres (ou deixe em branco).", "error");
      return;
    }

    const crlvFile = taxiDriverCrlvInputEl && taxiDriverCrlvInputEl.files && taxiDriverCrlvInputEl.files[0];
    if (crlvFile) {
      try {
        payload.crlvPhoto = await readFileAsDataUrl(crlvFile);
      } catch (error) {
        setMessage(createTaxiDriverMessageEl, "Não foi possível ler o arquivo do CRLV. Tente outro.", "error");
        return;
      }
    }

    authorizedFetch("/api/admin/taxi-drivers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (result) {
        if (!result.ok) {
          setMessage(createTaxiDriverMessageEl, result.body.error || "Não foi possível cadastrar o taxista.", "error");
          return;
        }

        taxiCredentialsUsernameEl.textContent = result.body.credentials.username;
        taxiCredentialsPasswordEl.textContent = result.body.credentials.password;
        createTaxiDriverFormEl.hidden = true;
        taxiCredentialsCardEl.hidden = false;
        loadTaxiDrivers();
      })
      .catch(function () {
        setMessage(createTaxiDriverMessageEl, "Erro de conexão com o servidor.", "error");
      });
  });

  createAnotherTaxiDriverButtonEl.addEventListener("click", function () {
    createTaxiDriverFormEl.reset();
    createTaxiDriverFormEl.hidden = false;
    taxiCredentialsCardEl.hidden = true;
    setMessage(createTaxiDriverMessageEl, "", "");
    if (taxiDriverCrlvStatusEl) {
      taxiDriverCrlvStatusEl.textContent = "Nenhum arquivo selecionado.";
    }
  });

  const providerCriminalRecordInputEl = document.getElementById("provider-criminal-record-input");
  const providerCriminalRecordStatusEl = document.getElementById("provider-criminal-record-status");

  if (providerCriminalRecordInputEl) {
    providerCriminalRecordInputEl.addEventListener("change", function () {
      const file = providerCriminalRecordInputEl.files && providerCriminalRecordInputEl.files[0];
      providerCriminalRecordStatusEl.textContent = file ? file.name : "Nenhum arquivo selecionado.";
    });
  }

  if (createProviderFormEl) {
    createProviderFormEl.addEventListener("submit", async function (event) {
      event.preventDefault();
      setMessage(createProviderMessageEl, "", "");

      const payload = {
        name: document.getElementById("provider-name-input").value.trim(),
        phone: document.getElementById("provider-phone-input").value.trim(),
        specialty: document.getElementById("provider-specialty-input").value.trim(),
        cpf: document.getElementById("provider-cpf-input").value.trim(),
        username: document.getElementById("provider-username-input").value.trim(),
        password: document.getElementById("provider-password-input").value.trim(),
        email: document.getElementById("provider-email-input").value.trim()
      };

      if (!payload.name || !payload.phone || !payload.specialty) {
        setMessage(createProviderMessageEl, "Preencha nome, telefone e especialidade do prestador.", "error");
        return;
      }

      if (payload.password && payload.password.length < 6) {
        setMessage(createProviderMessageEl, "A senha deve ter pelo menos 6 caracteres (ou deixe em branco).", "error");
        return;
      }

      const criminalRecordFile =
        providerCriminalRecordInputEl && providerCriminalRecordInputEl.files && providerCriminalRecordInputEl.files[0];
      if (criminalRecordFile) {
        try {
          payload.criminalRecordPhoto = await readFileAsDataUrl(criminalRecordFile);
        } catch (error) {
          setMessage(createProviderMessageEl, "Não foi possível ler o arquivo da certidão. Tente outro.", "error");
          return;
        }
      }

      authorizedFetch("/api/admin/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (result) {
          if (!result.ok) {
            setMessage(createProviderMessageEl, result.body.error || "Não foi possível cadastrar o prestador.", "error");
            return;
          }

          providerCredentialsUsernameEl.textContent = result.body.credentials.username;
          providerCredentialsPasswordEl.textContent = result.body.credentials.password;
          createProviderFormEl.hidden = true;
          providerCredentialsCardEl.hidden = false;
          loadProviders();
        })
        .catch(function () {
          setMessage(createProviderMessageEl, "Erro de conexão com o servidor.", "error");
        });
    });
  }

  if (createAnotherProviderButtonEl) {
    createAnotherProviderButtonEl.addEventListener("click", function () {
      createProviderFormEl.reset();
      createProviderFormEl.hidden = false;
      providerCredentialsCardEl.hidden = true;
      setMessage(createProviderMessageEl, "", "");
      if (providerCriminalRecordStatusEl) {
        providerCriminalRecordStatusEl.textContent = "Nenhum arquivo selecionado.";
      }
    });
  }

  logoutButtonEl.addEventListener("click", function () {
    showLogin();
  });
})();
