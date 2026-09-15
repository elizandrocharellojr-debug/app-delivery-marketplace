// Painel do prestador de serviço (Fase 9). Login próprio, separado do
// lojista e do admin. Mostra solicitações de orçamento que chegam dos
// clientes, agenda de atendimentos, serviços/preços, ganhos e avaliações.
// Segue o mesmo padrão visual (sidebar + cards) do painel do administrador
// e do painel do lojista, reaproveitando as classes .admin-dash-*.
(function () {
  "use strict";

  let providerToken = "";
  let providerName = "";
  let isAvailable = true;
  let cachedServices = [];
  const loadedSections = {};

  const loginScreenEl = document.getElementById("provider-login-screen");
  const panelScreenEl = document.getElementById("provider-panel-screen");
  const loginFormEl = document.getElementById("provider-login-form");
  const loginMessageEl = document.getElementById("provider-login-message");
  const usernameInputEl = document.getElementById("provider-username-input");
  const passwordInputEl = document.getElementById("provider-password-input");

  const navItemEls = Array.prototype.slice.call(document.querySelectorAll("#provider-dash-nav .admin-dash-nav-item"));
  const panelTitleEl = document.getElementById("provider-panel-title");
  const panelSubtitleEl = document.getElementById("provider-panel-subtitle");
  const logoutButtonEl = document.getElementById("provider-logout-button");

  const availabilityToggleEl = document.getElementById("provider-availability-toggle");
  const availabilitySwitchEl = document.getElementById("provider-availability-switch");
  const availabilityTextEl = document.getElementById("provider-availability-text");

  const kpiWeekEarningsEl = document.getElementById("kpi-week-earnings");
  const kpiResponseRateEl = document.getElementById("kpi-response-rate");

  const requestsListEl = document.getElementById("requests-list");
  const requestsCountBadgeEl = document.getElementById("requests-count-badge");
  const agendaTodayListEl = document.getElementById("agenda-today-list");
  const servicesPreviewListEl = document.getElementById("services-preview-list");
  const servicesPreviewAddButtonEl = document.getElementById("services-preview-add-button");

  const agendaFullListEl = document.getElementById("agenda-full-list");

  const servicesEditorListEl = document.getElementById("services-editor-list");
  const servicesMessageEl = document.getElementById("services-message");
  const addServiceButtonEl = document.getElementById("add-service-button");

  const visitFeeFormEl = document.getElementById("visit-fee-form");
  const visitFeeInputEl = document.getElementById("visit-fee-input");
  const visitFeeMessageEl = document.getElementById("visit-fee-message");
  let currentVisitFee = 0;

  const earningsWeekTotalEl = document.getElementById("earnings-week-total");
  const earningsTotalEl = document.getElementById("earnings-total");
  const earningsTableBodyEl = document.getElementById("earnings-table-body");

  const reviewsSummaryEl = document.getElementById("provider-reviews-summary");
  const reviewsListEl = document.getElementById("provider-reviews-list");

  const SECTION_TITLES = {
    solicitacoes: ["Solicitações", ""],
    agenda: ["Agenda", ""],
    servicos: ["Serviços e preços", ""],
    ganhos: ["Ganhos", ""],
    avaliacoes: ["Avaliações", ""]
  };

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function formatDateTime(value) {
    if (!value) {
      return "-";
    }
    return new Date(value).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatTime(value) {
    if (!value) {
      return "-";
    }
    return new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
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
    const headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + providerToken });
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

  function showPanel() {
    loginScreenEl.hidden = true;
    panelScreenEl.hidden = false;
    for (const key in loadedSections) {
      delete loadedSections[key];
    }
    loadDashboard();
    setupNav();
  }

  function showLogin() {
    providerToken = "";
    panelScreenEl.hidden = true;
    loginScreenEl.hidden = false;
    passwordInputEl.value = "";
  }

  function setupNav() {
    navItemEls.forEach(function (item) {
      item.onclick = function () {
        switchSection(item.dataset.section);
      };
    });
  }

  function switchSection(section) {
    navItemEls.forEach(function (item) {
      item.classList.toggle("active", item.dataset.section === section);
    });

    document.querySelectorAll(".admin-dash-section").forEach(function (panel) {
      panel.hidden = panel.id !== "provider-section-" + section;
    });

    const titles = SECTION_TITLES[section] || ["", ""];
    panelSubtitleEl.textContent = titles[0] + " · " + providerName;

    if (!loadedSections[section]) {
      loadedSections[section] = true;
      if (section === "agenda") {
        loadFullAgenda();
      }
      if (section === "ganhos") {
        loadEarnings();
      }
      if (section === "avaliacoes") {
        loadReviews();
      }
      if (section === "servicos") {
        renderServicesEditor(cachedServices);
      }
    }
  }

  // -- Disponibilidade ------------------------------------------------------

  function renderAvailability(value) {
    isAvailable = !!value;
    availabilityTextEl.textContent = isAvailable ? "Disponível" : "Indisponível";
    availabilitySwitchEl.classList.toggle("is-on", isAvailable);
    availabilityToggleEl.classList.toggle("is-closed", !isAvailable);
  }

  availabilityToggleEl.addEventListener("click", function () {
    const next = !isAvailable;
    renderAvailability(next);
    availabilityToggleEl.disabled = true;

    authorizedFetch("/api/provider/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAvailable: next })
    })
      .then(function (result) {
        if (!result.ok) {
          renderAvailability(!next);
        }
      })
      .catch(function () {
        renderAvailability(!next);
      })
      .finally(function () {
        availabilityToggleEl.disabled = false;
      });
  });

  // -- Dashboard (Solicitações + Agenda de hoje + preview de serviços) ------

  function renderRequestCard(request) {
    const item = document.createElement("div");
    item.className = "admin-dash-request-card";
    item.dataset.requestId = request.id;

    const top = document.createElement("div");
    top.className = "admin-dash-request-top";
    const name = document.createElement("strong");
    name.textContent = request.customerName + (request.locationLabel ? " · " + request.locationLabel : "");
    const pill = document.createElement("span");
    pill.className = "status-pill status-pill-pending";
    pill.textContent = request.awaitingQuoteAfterVisit ? "Visita concluída" : "Aguardando";
    top.appendChild(name);
    top.appendChild(pill);

    const message = document.createElement("p");
    message.className = "admin-dash-request-message";
    message.textContent = request.awaitingQuoteAfterVisit
      ? "Visita já feita - hora de mandar o orçamento final do serviço."
      : '"' + (request.message || "") + '"';

    const cardMessageEl = document.createElement("div");
    cardMessageEl.className = "inline-message";

    const actions = document.createElement("div");
    actions.className = "admin-dash-request-actions";

    const rejectButton = document.createElement("button");
    rejectButton.type = "button";
    rejectButton.className = "secondary-button";
    rejectButton.textContent = "Recusar";
    actions.appendChild(rejectButton);

    let visitButton = null;
    if (!request.awaitingQuoteAfterVisit) {
      visitButton = document.createElement("button");
      visitButton.type = "button";
      visitButton.className = "secondary-button";
      visitButton.textContent = currentVisitFee > 0 ? "Pedir visita (R$ " + currentVisitFee.toFixed(2).replace(".", ",") + ")" : "Pedir visita";
      actions.appendChild(visitButton);
    }

    const quoteButton = document.createElement("button");
    quoteButton.type = "button";
    quoteButton.className = "primary-button";
    quoteButton.textContent = "Enviar orçamento";
    actions.appendChild(quoteButton);

    const quoteForm = document.createElement("div");
    quoteForm.className = "admin-dash-request-quote-form";
    quoteForm.hidden = true;
    quoteForm.innerHTML =
      '<label class="field"><span>Preço (R$)</span><input type="number" min="0" step="0.01" class="quote-price-input" placeholder="Ex.: 80" /></label>' +
      '<label class="field"><span>Data e hora do atendimento</span><input type="datetime-local" class="quote-datetime-input" /></label>' +
      '<button type="button" class="primary-button quote-confirm-button">Confirmar orçamento</button>';

    const visitForm = document.createElement("div");
    visitForm.className = "admin-dash-request-quote-form";
    visitForm.hidden = true;
    visitForm.innerHTML =
      '<label class="field"><span>Data e hora da visita</span><input type="datetime-local" class="visit-datetime-input" /></label>' +
      '<button type="button" class="primary-button visit-confirm-button">Confirmar pedido de visita</button>';

    item.appendChild(top);
    item.appendChild(message);
    item.appendChild(cardMessageEl);
    item.appendChild(actions);
    item.appendChild(quoteForm);
    item.appendChild(visitForm);
    item.appendChild(buildChatSection(request.id));

    rejectButton.addEventListener("click", function () {
      if (!window.confirm("Recusar essa solicitação de " + request.customerName + "?")) {
        return;
      }
      rejectButton.disabled = true;
      quoteButton.disabled = true;
      if (visitButton) {
        visitButton.disabled = true;
      }
      respondToRequest(request.id, { action: "recusar" }).then(function (result) {
        if (result.ok) {
          loadDashboard();
        } else {
          rejectButton.disabled = false;
          quoteButton.disabled = false;
          if (visitButton) {
            visitButton.disabled = false;
          }
          setMessage(cardMessageEl, (result.body && result.body.error) || "Não foi possível recusar.", "error");
        }
      });
    });

    if (visitButton) {
      visitButton.addEventListener("click", function () {
        visitForm.hidden = !visitForm.hidden;
        quoteForm.hidden = true;
      });

      visitForm.querySelector(".visit-confirm-button").addEventListener("click", function () {
        const datetimeInput = visitForm.querySelector(".visit-datetime-input");
        const scheduledAt = datetimeInput.value;

        if (!scheduledAt) {
          datetimeInput.style.borderColor = "#c0392b";
          return;
        }

        const confirmButton = visitForm.querySelector(".visit-confirm-button");
        confirmButton.disabled = true;

        respondToRequest(request.id, {
          action: "visita",
          scheduledAt: new Date(scheduledAt).toISOString()
        }).then(function (result) {
          confirmButton.disabled = false;
          if (result.ok) {
            loadDashboard();
          } else {
            setMessage(cardMessageEl, (result.body && result.body.error) || "Não foi possível pedir a visita.", "error");
          }
        });
      });
    }

    quoteButton.addEventListener("click", function () {
      quoteForm.hidden = !quoteForm.hidden;
      visitForm.hidden = true;
    });

    quoteForm.querySelector(".quote-confirm-button").addEventListener("click", function () {
      const priceInput = quoteForm.querySelector(".quote-price-input");
      const datetimeInput = quoteForm.querySelector(".quote-datetime-input");
      const price = Number(priceInput.value);
      const scheduledAt = datetimeInput.value;

      if (!(price > 0) || !scheduledAt) {
        priceInput.style.borderColor = price > 0 ? "" : "#c0392b";
        datetimeInput.style.borderColor = scheduledAt ? "" : "#c0392b";
        return;
      }

      const confirmButton = quoteForm.querySelector(".quote-confirm-button");
      confirmButton.disabled = true;

      respondToRequest(request.id, {
        action: "orcamento",
        price: price,
        scheduledAt: new Date(scheduledAt).toISOString()
      }).then(function (result) {
        confirmButton.disabled = false;
        if (result.ok) {
          loadDashboard();
        } else {
          setMessage(cardMessageEl, (result.body && result.body.error) || "Não foi possível enviar o orçamento.", "error");
        }
      });
    });

    return item;
  }

  // Conversa (chat) embutida nos cards de solicitação e nos itens da
  // agenda - o mesmo pedido de orçamento (budgetRequestId) é a chave que
  // liga tudo: o pedido inicial, a resposta do prestador e o atendimento
  // agendado compartilham a mesma conversa.
  function buildChatSection(budgetRequestId) {
    const wrap = document.createElement("div");
    wrap.className = "provider-chat-wrap";

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "secondary-button small-button";
    toggleButton.textContent = "Ver conversa";

    const panel = document.createElement("div");
    panel.className = "provider-chat-panel";
    panel.hidden = true;
    panel.innerHTML =
      '<div class="chat-thread provider-chat-thread"></div>' +
      '<div class="provider-chat-quick-replies">' +
      '<button type="button" class="secondary-button small-button" data-quick="Estou a caminho">Estou a caminho</button>' +
      '<button type="button" class="secondary-button small-button" data-quick="Cheguei no local">Cheguei no local</button>' +
      '<button type="button" class="secondary-button small-button" data-quick="Iniciei o serviço">Iniciei o serviço</button>' +
      "</div>" +
      '<form class="chat-message-form provider-chat-form">' +
      '<textarea class="field-textarea provider-chat-input" rows="2" placeholder="Responder ao cliente..."></textarea>' +
      '<button class="primary-button" type="submit">Enviar</button>' +
      "</form>";

    const threadEl = panel.querySelector(".provider-chat-thread");
    const formEl = panel.querySelector(".provider-chat-form");
    const inputEl = panel.querySelector(".provider-chat-input");
    const quickReplyButtons = Array.prototype.slice.call(panel.querySelectorAll("[data-quick]"));

    let loaded = false;

    function escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text == null ? "" : String(text);
      return div.innerHTML;
    }

    function renderMessages(messages) {
      threadEl.innerHTML = messages
        .map(function (message) {
          const kind = message.senderType === "system" ? "system" : message.senderType === "provider" ? "provider" : "customer";
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
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    function loadMessages() {
      authorizedFetch("/api/provider/budget-requests/" + encodeURIComponent(budgetRequestId))
        .then(function (result) {
          if (!result.ok) {
            return;
          }
          renderMessages(result.body.messages || []);
        })
        .catch(function () {});
    }

    function sendMessage(body, button) {
      if (!body) {
        return;
      }

      if (button) {
        button.disabled = true;
      }

      authorizedFetch("/api/provider/budget-requests/" + encodeURIComponent(budgetRequestId) + "/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body })
      })
        .then(function (result) {
          if (result.ok) {
            inputEl.value = "";
            loadMessages();
          }
        })
        .catch(function () {})
        .finally(function () {
          if (button) {
            button.disabled = false;
          }
        });
    }

    toggleButton.addEventListener("click", function () {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && !loaded) {
        loaded = true;
        loadMessages();
      }
    });

    // Botões de status rápido - o prestador narra o andamento do serviço
    // sem precisar digitar, tocando uma vez ("Cheguei no local", "Iniciei o
    // serviço"...). Entra no mesmo fio de conversa que o cliente já
    // acompanha.
    quickReplyButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        sendMessage(button.dataset.quick, button);
      });
    });

    formEl.addEventListener("submit", function (event) {
      event.preventDefault();
      sendMessage(inputEl.value.trim());
    });

    wrap.appendChild(toggleButton);
    wrap.appendChild(panel);
    return wrap;
  }

  function respondToRequest(requestId, payload) {
    return authorizedFetch("/api/provider/budget-requests/" + encodeURIComponent(requestId) + "/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(function () {
      return { ok: false, body: { error: "Erro de conexão com o servidor." } };
    });
  }

  function renderRequests(requests) {
    requestsListEl.innerHTML = "";
    requestsCountBadgeEl.textContent = String(requests.length);

    if (!requests.length) {
      requestsListEl.innerHTML = '<div class="admin-dash-empty-hint">Nenhuma solicitação pendente.</div>';
      return;
    }

    requests.forEach(function (request) {
      requestsListEl.appendChild(renderRequestCard(request));
    });
  }

  function renderAgendaItem(booking, showActions) {
    const item = document.createElement("div");
    item.className = "admin-dash-agenda-item";

    const time = document.createElement("div");
    time.className = "admin-dash-agenda-time";
    time.textContent = formatTime(booking.scheduledAt);

    const info = document.createElement("div");
    info.className = "admin-dash-agenda-info";
    const title = document.createElement("strong");
    title.textContent = booking.serviceName || "Atendimento";
    const meta = document.createElement("span");
    meta.textContent =
      booking.customerName + (booking.locationLabel ? " · " + booking.locationLabel : "") + " · " + formatMoney(booking.price);
    info.appendChild(title);
    info.appendChild(meta);

    item.appendChild(time);
    item.appendChild(info);

    if (booking.kind === "visita") {
      const visitPill = document.createElement("span");
      visitPill.className = "status-pill";
      visitPill.textContent = "Visita técnica";
      item.appendChild(visitPill);
    }

    const statusPill = document.createElement("span");
    statusPill.className = "status-pill";
    statusPill.textContent =
      booking.status === "concluido" ? "Concluído" : booking.status === "cancelado" ? "Cancelado" : "Agendado";
    item.appendChild(statusPill);

    if (booking.paymentStatus === "pago") {
      const paidPill = document.createElement("span");
      paidPill.className = "status-pill";
      paidPill.textContent = "Pago pelo app";
      item.appendChild(paidPill);
    }

    const agendaMessageEl = document.createElement("div");
    agendaMessageEl.className = "inline-message";

    if (showActions && booking.status === "agendado") {
      const actions = document.createElement("div");
      actions.className = "admin-dash-agenda-actions";

      const doneButton = document.createElement("button");
      doneButton.type = "button";
      doneButton.className = "admin-dash-small-button";
      doneButton.textContent = "Concluído";
      doneButton.addEventListener("click", function () {
        updateBookingStatus(booking.id, "concluido", agendaMessageEl);
      });

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "secondary-button small-button";
      cancelButton.textContent = "Cancelar";
      cancelButton.addEventListener("click", function () {
        if (window.confirm("Cancelar esse atendimento?")) {
          updateBookingStatus(booking.id, "cancelado", agendaMessageEl);
        }
      });

      actions.appendChild(doneButton);
      actions.appendChild(cancelButton);

      if (booking.paymentStatus !== "pago" && Number(booking.price || 0) > 0) {
        const payLinkButton = document.createElement("button");
        payLinkButton.type = "button";
        payLinkButton.className = "secondary-button small-button";
        payLinkButton.textContent = "Copiar link de pagamento";
        payLinkButton.addEventListener("click", function () {
          const url = window.location.origin + "/pagar-atendimento.html?id=" + encodeURIComponent(booking.id);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () {
              payLinkButton.textContent = "Link copiado!";
              window.setTimeout(function () {
                payLinkButton.textContent = "Copiar link de pagamento";
              }, 2000);
            });
          } else {
            window.prompt("Copie o link e mande pro cliente:", url);
          }
        });
        actions.appendChild(payLinkButton);
      }

      item.appendChild(actions);
      item.appendChild(agendaMessageEl);
    }

    if (booking.budgetRequestId) {
      item.appendChild(buildChatSection(booking.budgetRequestId));
    }

    return item;
  }

  function updateBookingStatus(bookingId, status, messageEl) {
    authorizedFetch("/api/provider/bookings/" + encodeURIComponent(bookingId) + "/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: status })
    })
      .then(function (result) {
        if (result.ok) {
          loadDashboard();
          if (loadedSections.agenda) {
            loadFullAgenda();
          }
          if (loadedSections.ganhos) {
            loadEarnings();
          }
        } else if (messageEl) {
          setMessage(messageEl, (result.body && result.body.error) || "Não foi possível atualizar.", "error");
        }
      })
      .catch(function () {
        if (messageEl) {
          setMessage(messageEl, "Erro de conexão com o servidor.", "error");
        }
      });
  }

  function renderAgendaToday(bookings) {
    agendaTodayListEl.innerHTML = "";

    if (!bookings.length) {
      agendaTodayListEl.innerHTML = '<div class="admin-dash-empty-hint">Nenhum atendimento agendado pra hoje.</div>';
      return;
    }

    bookings.forEach(function (booking) {
      agendaTodayListEl.appendChild(renderAgendaItem(booking, true));
    });
  }

  function renderServicesPreview(services) {
    servicesPreviewListEl.innerHTML = "";

    if (!services.length) {
      servicesPreviewListEl.innerHTML = '<div class="admin-dash-empty-hint">Nenhum serviço cadastrado ainda.</div>';
      return;
    }

    services.forEach(function (service) {
      const row = document.createElement("div");
      row.className = "admin-dash-service-row";
      row.innerHTML = "<span>" + service.name + "</span>";
      servicesPreviewListEl.appendChild(row);
    });
  }

  function loadDashboard() {
    authorizedFetch("/api/provider/dashboard")
      .then(function (result) {
        if (!result.ok) {
          return;
        }
        const data = result.body;
        providerName = data.provider.name;
        panelTitleEl.textContent = data.provider.name;
        panelSubtitleEl.textContent =
          "Painel do prestador · " +
          (data.avgRating != null ? "★ " + data.avgRating.toFixed(1) : "Sem avaliações ainda") +
          " · " +
          data.servicosConcluidos +
          (data.servicosConcluidos === 1 ? " serviço concluído" : " serviços concluídos");

        renderAvailability(data.provider.isAvailable);

        kpiWeekEarningsEl.textContent = formatMoney(data.ganhosSemana);
        kpiResponseRateEl.textContent = data.taxaResposta != null ? data.taxaResposta + "%" : "Sem dados";

        renderRequests(data.solicitacoesPendentes);
        renderAgendaToday(data.agendaHoje);
        renderServicesPreview(data.servicos);
        cachedServices = data.servicos || [];
        if (loadedSections.servicos) {
          renderServicesEditor(cachedServices);
        }

        currentVisitFee = Number(data.provider.visitFee || 0);
        if (visitFeeInputEl && document.activeElement !== visitFeeInputEl) {
          visitFeeInputEl.value = currentVisitFee || "";
        }
      })
      .catch(function () {});
  }

  if (visitFeeFormEl) {
    visitFeeFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      const visitFee = Number(visitFeeInputEl.value || 0);

      if (!(visitFee >= 0)) {
        setMessage(visitFeeMessageEl, "Informe um valor válido.", "error");
        return;
      }

      setMessage(visitFeeMessageEl, "Salvando...", "");

      authorizedFetch("/api/provider/visit-fee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitFee: visitFee })
      })
        .then(function (result) {
          if (!result.ok) {
            setMessage(visitFeeMessageEl, result.body.error || "Não foi possível salvar.", "error");
            return;
          }
          currentVisitFee = visitFee;
          setMessage(
            visitFeeMessageEl,
            visitFee > 0 ? "Salvo! Agora você pode pedir visita paga nos pedidos." : "Salvo. Visita sem cobrança.",
            "success"
          );
        })
        .catch(function () {
          setMessage(visitFeeMessageEl, "Erro de conexão com o servidor.", "error");
        });
    });
  }

  if (servicesPreviewAddButtonEl) {
    servicesPreviewAddButtonEl.addEventListener("click", function () {
      switchSection("servicos");
    });
  }

  // -- Agenda completa --------------------------------------------------------

  function loadFullAgenda() {
    agendaFullListEl.innerHTML = '<div class="admin-dash-empty-hint">Carregando...</div>';

    authorizedFetch("/api/provider/bookings")
      .then(function (result) {
        if (!result.ok) {
          return;
        }
        const bookings = result.body.bookings || [];
        agendaFullListEl.innerHTML = "";

        if (!bookings.length) {
          agendaFullListEl.innerHTML = '<div class="admin-dash-empty-hint">Nenhum atendimento agendado ainda.</div>';
          return;
        }

        bookings
          .slice()
          .sort(function (a, b) {
            return new Date(b.scheduledAt) - new Date(a.scheduledAt);
          })
          .forEach(function (booking) {
            agendaFullListEl.appendChild(renderAgendaItem(booking, true));
          });
      })
      .catch(function () {});
  }

  // -- Servicos e preços (editor completo) -------------------------------

  function renderServicesEditor(services) {
    servicesEditorListEl.innerHTML = "";

    if (!services.length) {
      servicesEditorListEl.innerHTML = '<div class="admin-dash-empty-hint">Nenhum serviço cadastrado ainda.</div>';
      return;
    }

    services.forEach(function (service) {
      const row = document.createElement("div");
      row.className = "admin-dash-service-row admin-dash-service-row-editable";
      row.dataset.serviceId = service.id;

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "service-name-input";
      nameInput.value = service.name;

      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.className = "admin-dash-small-button";
      saveButton.textContent = "Salvar";
      saveButton.addEventListener("click", function () {
        saveService(service.id, nameInput.value.trim());
      });

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "secondary-button small-button danger-button";
      removeButton.textContent = "Remover";
      removeButton.addEventListener("click", function () {
        if (window.confirm("Remover o serviço " + service.name + "?")) {
          deleteService(service.id);
        }
      });

      row.appendChild(nameInput);
      row.appendChild(saveButton);
      row.appendChild(removeButton);
      servicesEditorListEl.appendChild(row);
    });
  }

  function saveService(id, name) {
    if (!name) {
      setMessage(servicesMessageEl, "Preencha o nome do serviço.", "error");
      return;
    }

    setMessage(servicesMessageEl, "Salvando...", "");

    authorizedFetch("/api/provider/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id || "", name: name })
    })
      .then(function (result) {
        if (!result.ok) {
          setMessage(servicesMessageEl, result.body.error || "Não foi possível salvar.", "error");
          return;
        }
        setMessage(servicesMessageEl, "Serviço salvo com sucesso.", "success");
        cachedServices = result.body.services || [];
        renderServicesEditor(cachedServices);
        renderServicesPreview(cachedServices);
      })
      .catch(function () {
        setMessage(servicesMessageEl, "Erro de conexão com o servidor.", "error");
      });
  }

  function deleteService(id) {
    authorizedFetch("/api/provider/services/" + encodeURIComponent(id), { method: "DELETE" })
      .then(function (result) {
        if (result.ok) {
          cachedServices = result.body.services || [];
          renderServicesEditor(cachedServices);
          renderServicesPreview(cachedServices);
        }
      })
      .catch(function () {});
  }

  if (addServiceButtonEl) {
    addServiceButtonEl.addEventListener("click", function () {
      const row = document.createElement("div");
      row.className = "admin-dash-service-row admin-dash-service-row-editable";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "service-name-input";
      nameInput.placeholder = "Nome do serviço";

      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.className = "admin-dash-small-button";
      saveButton.textContent = "Salvar";
      saveButton.addEventListener("click", function () {
        saveService("", nameInput.value.trim());
      });

      row.appendChild(nameInput);
      row.appendChild(saveButton);
      servicesEditorListEl.appendChild(row);
      nameInput.focus();
    });
  }

  // -- Ganhos ---------------------------------------------------------------

  function loadEarnings() {
    earningsTableBodyEl.innerHTML = '<tr><td colspan="5" class="admin-dash-empty-hint">Carregando...</td></tr>';

    authorizedFetch("/api/provider/earnings")
      .then(function (result) {
        if (!result.ok) {
          return;
        }
        const data = result.body;
        earningsWeekTotalEl.textContent = formatMoney(data.weekTotal);
        earningsTotalEl.textContent = formatMoney(data.total);
        earningsTableBodyEl.innerHTML = "";

        if (!data.bookings.length) {
          earningsTableBodyEl.innerHTML =
            '<tr><td colspan="5" class="admin-dash-empty-hint">Nenhum atendimento registrado ainda.</td></tr>';
          return;
        }

        data.bookings.forEach(function (booking) {
          const row = document.createElement("tr");
          row.innerHTML =
            "<td>" + booking.customerName + "</td>" +
            "<td>" + (booking.serviceName || "-") + "</td>" +
            '<td class="is-money">' + formatMoney(booking.price) + "</td>" +
            '<td><span class="status-pill">' +
            (booking.status === "concluido" ? "Concluído" : booking.status === "cancelado" ? "Cancelado" : "Agendado") +
            "</span></td>" +
            "<td>" + formatDateTime(booking.scheduledAt) + "</td>";
          earningsTableBodyEl.appendChild(row);
        });
      })
      .catch(function () {});
  }

  // -- Avaliacoes -------------------------------------------------------------

  function starString(rating) {
    const rounded = Math.round(Number(rating) || 0);
    return "★".repeat(Math.max(0, Math.min(5, rounded))) + "☆".repeat(5 - Math.max(0, Math.min(5, rounded)));
  }

  function loadReviews() {
    authorizedFetch("/api/provider/reviews")
      .then(function (result) {
        if (!result.ok) {
          return;
        }
        const data = result.body;

        if (data.averageRating != null) {
          reviewsSummaryEl.innerHTML =
            "<strong>" + data.averageRating.toFixed(1) + "</strong>" +
            "<span>" + starString(data.averageRating) + " · " + data.reviewsCount + " avaliação(ões)</span>";
        } else {
          reviewsSummaryEl.innerHTML = "<span>Você ainda não recebeu avaliações.</span>";
        }

        reviewsListEl.innerHTML = "";
        (data.reviews || []).forEach(function (review) {
          const item = document.createElement("div");
          item.className = "admin-dash-review-item";
          item.innerHTML =
            '<div class="admin-dash-review-top"><strong>' +
            (review.customerName || "Cliente") +
            '</strong><span class="admin-dash-review-stars">' +
            starString(review.rating) +
            "</span></div>" +
            (review.comment ? '<p class="admin-dash-review-comment">' + review.comment + "</p>" : "") +
            '<span class="admin-dash-review-date">' +
            new Date(review.createdAt).toLocaleDateString("pt-BR") +
            "</span>";
          reviewsListEl.appendChild(item);
        });
      })
      .catch(function () {});
  }

  // -- Login / logout -------------------------------------------------------

  loginFormEl.addEventListener("submit", function (event) {
    event.preventDefault();
    setMessage(loginMessageEl, "", "");

    const username = usernameInputEl.value.trim();
    const password = passwordInputEl.value;

    if (!username || !password) {
      setMessage(loginMessageEl, "Preencha usuário e senha.", "error");
      return;
    }

    fetch("/api/provider/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          setMessage(loginMessageEl, result.body.error || "Não foi possível entrar.", "error");
          return;
        }
        providerToken = result.body.token;
        providerName = result.body.provider.name;
        showPanel();
      })
      .catch(function () {
        setMessage(loginMessageEl, "Erro de conexão com o servidor.", "error");
      });
  });

  logoutButtonEl.addEventListener("click", function () {
    showLogin();
  });
})();
