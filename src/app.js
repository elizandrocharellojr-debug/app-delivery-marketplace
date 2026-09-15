(function app() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  // Se a pessoa voltou de category.html (ex: clicou num ícone dentro de
  // "Comida" e depois apertou voltar), a URL traz ?expand=comida pra Home
  // já abrir direto naquele grupo de ícones, em vez de voltar pra raiz.
  var initialExpandParam = new URLSearchParams(window.location.search).get("expand");

  var state = {
    tab: "estabelecimentos",
    search: "",
    categoryView: initialExpandParam || "root",
  };

  // Ícones padrão da Home - usados só como fallback enquanto a lista real
  // não chega do servidor (GET /api/home-chips), que é editável no painel
  // administrativo. parentId vazio = ícone principal; parentId preenchido =
  // ícone que só aparece dentro do grupo pai (ex: os de dentro de "Comida").
  var DEFAULT_HOME_CHIPS = [
    { id: "comida", parentId: "", label: "Comida", icon: "fa-utensils", kind: "group", categoryId: "comida", subCategory: "", searchTerm: "", sortOrder: 0 },
    { id: "lojas", parentId: "", label: "Lojas", icon: "fa-bag-shopping", kind: "link", categoryId: "lojas", subCategory: "", searchTerm: "", sortOrder: 1 },
    { id: "mercados", parentId: "", label: "Mercados", icon: "fa-cart-shopping", kind: "link", categoryId: "mercados-farmacias", subCategory: "mercado", searchTerm: "", sortOrder: 2 },
    { id: "farmacias", parentId: "", label: "Farmácias", icon: "fa-briefcase-medical", kind: "link", categoryId: "mercados-farmacias", subCategory: "farmacia", searchTerm: "", sortOrder: 3 },
    { id: "lanches", parentId: "comida", label: "Lanches", icon: "fa-burger", kind: "link", categoryId: "comida", subCategory: "", searchTerm: "Lanches", sortOrder: 0 },
    { id: "pizza", parentId: "comida", label: "Pizza", icon: "fa-pizza-slice", kind: "link", categoryId: "comida", subCategory: "", searchTerm: "Pizza", sortOrder: 1 },
    { id: "marmita", parentId: "comida", label: "Marmita", icon: "fa-bowl-food", kind: "link", categoryId: "comida", subCategory: "", searchTerm: "Marmita", sortOrder: 2 },
    { id: "doces", parentId: "comida", label: "Doces", icon: "fa-cake-candles", kind: "link", categoryId: "comida", subCategory: "", searchTerm: "Doces", sortOrder: 3 },
    { id: "bebidas", parentId: "comida", label: "Bebidas", icon: "fa-mug-saucer", kind: "link", categoryId: "comida", subCategory: "", searchTerm: "Bebidas", sortOrder: 4 },
  ];

  var homeChips = DEFAULT_HOME_CHIPS;

  function getRootChips() {
    return homeChips
      .filter(function (chip) {
        return !chip.parentId;
      })
      .sort(function (a, b) {
        return (a.sortOrder || 0) - (b.sortOrder || 0);
      });
  }

  function getChildChips(parentId) {
    return homeChips
      .filter(function (chip) {
        return chip.parentId === parentId;
      })
      .sort(function (a, b) {
        return (a.sortOrder || 0) - (b.sortOrder || 0);
      });
  }

  function getChipById(id) {
    for (var i = 0; i < homeChips.length; i += 1) {
      if (homeChips[i].id === id) {
        return homeChips[i];
      }
    }
    return null;
  }

  function safeIconClass(icon) {
    var value = String(icon || "").trim();
    return /^[a-z0-9-]+$/i.test(value) ? value : "fa-circle";
  }

  function chipHref(chip) {
    var href = "./category.html?category=" + encodeURIComponent(chip.categoryId || "comida");
    if (chip.subCategory) {
      href += "&sub=" + encodeURIComponent(chip.subCategory);
    }
    if (chip.searchTerm) {
      href += "&search=" + encodeURIComponent(chip.searchTerm);
    }
    return href;
  }

  function loadHomeChips() {
    if (!window.fetch) {
      return;
    }

    window
      .fetch("/api/home-chips", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Falha ao carregar ícones da Home.");
        }
        return response.json();
      })
      .then(function (result) {
        if (result && Array.isArray(result.chips) && result.chips.length) {
          homeChips = result.chips;
          render();
        }
      })
      .catch(function () {
        // Mantém os ícones padrão (DEFAULT_HOME_CHIPS) se a busca falhar.
      });
  }

  var categoriesEl = document.getElementById("categories");
  var backButtonEl = document.getElementById("home-back-button");
  var categoriesSectionEl = document.getElementById("categories-section");
  var searchFormEl = document.getElementById("search-form");
  var searchInputEl = document.getElementById("search-input");
  var addressValueEl = document.getElementById("home-address-value");
  var addressButtonEl = document.getElementById("home-address-button");
  var nearbyListEl = document.getElementById("nearby-list");
  var nearbyTitleEl = document.getElementById("nearby-title");
  var nearbySeeAllEl = document.getElementById("nearby-see-all");
  var tabButtons = Array.prototype.slice.call(document.querySelectorAll(".home-tab"));

  var providersCache = null;

  function getData() {
    return window.appDatabase.load();
  }

  function moneyLabel(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function renderAddress() {
    var profile = window.appDatabase.getProfile();
    var address = window.appDatabase.getCurrentAddress(profile);

    if (!address || (!address.street && !address.number)) {
      addressValueEl.textContent = "Adicionar endereço";
      return;
    }

    var label = [address.street, address.number].filter(Boolean).join(", ");
    addressValueEl.textContent = label || "Adicionar endereço";
  }

  function renderCategories(data) {
    var escapeHtml = window.appDatabase.escapeHtml;

    if (state.tab === "servicos") {
      categoriesEl.innerHTML = "";
      categoriesSectionEl.hidden = true;
      return;
    }

    categoriesSectionEl.hidden = false;

    if (state.categoryView !== "root") {
      var children = getChildChips(state.categoryView);

      if (!children.length) {
        state.categoryView = "root";
      } else {
        var backChip =
          '<button type="button" class="home-chip" data-action="back-to-root">' +
          '<span class="home-chip-circle"><i class="fas fa-arrow-left"></i></span>' +
          '<span class="home-chip-name">Categorias</span>' +
          "</button>";

        categoriesEl.innerHTML =
          backChip +
          children
            .map(function (chip) {
              var href = chipHref(chip) + "&from=" + encodeURIComponent(state.categoryView);
              return (
                '<a class="home-chip" href="' +
                href +
                '">' +
                '<span class="home-chip-circle"><i class="fas ' +
                safeIconClass(chip.icon) +
                '"></i></span>' +
                '<span class="home-chip-name">' +
                escapeHtml(chip.label) +
                "</span>" +
                "</a>"
              );
            })
            .join("");
        return;
      }
    }

    categoriesEl.innerHTML = getRootChips()
      .map(function (chip) {
        if (chip.kind === "group") {
          return (
            '<button type="button" class="home-chip" data-action="expand" data-expand="' +
            chip.id +
            '">' +
            '<span class="home-chip-circle"><i class="fas ' +
            safeIconClass(chip.icon) +
            '"></i></span>' +
            '<span class="home-chip-name">' +
            escapeHtml(chip.label) +
            "</span>" +
            "</button>"
          );
        }

        return (
          '<a class="home-chip" href="' +
          chipHref(chip) +
          '">' +
          '<span class="home-chip-circle"><i class="fas ' +
          safeIconClass(chip.icon) +
          '"></i></span>' +
          '<span class="home-chip-name">' +
          escapeHtml(chip.label) +
          "</span>" +
          "</a>"
        );
      })
      .join("");
  }

  function renderStoresNearby(data) {
    var escapeHtml = window.appDatabase.escapeHtml;
    var sanitizeUrl = window.appDatabase.sanitizeUrl;
    var query = state.search.trim().toLowerCase();

    var activeGroupChip = state.categoryView !== "root" ? getChipById(state.categoryView) : null;

    var stores = data.stores
      .filter(function (store) {
        if (store.isActive === false || store.categoryId === "servicos") {
          return false;
        }
        if (activeGroupChip && activeGroupChip.categoryId) {
          return store.categoryId === activeGroupChip.categoryId;
        }
        return true;
      })
      .filter(function (store) {
        if (!query) {
          return true;
        }

        var haystack = (store.name + " " + (store.coverLabel || "") + " " + (store.tags || []).join(" ")).toLowerCase();
        return haystack.indexOf(query) >= 0;
      })
      .slice()
      .sort(function (a, b) {
        return (b.rating || 0) - (a.rating || 0);
      });

    if (!stores.length) {
      nearbyListEl.innerHTML = '<div class="nearby-empty">Nenhum estabelecimento encontrado.</div>';
      return;
    }

    nearbyListEl.innerHTML = stores
      .slice(0, 10)
      .map(function (store) {
        var safeLogoUrl = sanitizeUrl(store.logoUrl);
        var photoStyle = safeLogoUrl ? ' style="background-image:url(\'' + safeLogoUrl + '\')"' : "";
        var feeValue = window.appDatabase.getDeliveryFeeForStore
          ? window.appDatabase.getDeliveryFeeForStore(store)
          : Number(store.deliveryFee) || 0;
        var feeLabel =
          Number(feeValue) > 0
            ? "<span>" + moneyLabel(feeValue) + "</span>"
            : '<span class="is-free">Entrega grátis</span>';

        return (
          '<a class="nearby-card" href="./store.html?store=' +
          store.id +
          '">' +
          '<div class="nearby-card-avatar' +
          (safeLogoUrl ? " has-image" : "") +
          '"' +
          photoStyle +
          ">" +
          (safeLogoUrl ? "" : '<span class="nearby-card-avatar-fallback">' + (store.icon || "🍽️") + "</span>") +
          "</div>" +
          '<div class="nearby-card-body">' +
          "<strong>" +
          escapeHtml(store.name) +
          "</strong>" +
          '<div class="nearby-card-meta">' +
          '<span class="nearby-card-rating"><i class="fas fa-star"></i>' +
          Number(store.rating || 0).toFixed(1) +
          "</span>" +
          (store.deliveryTime
            ? '<span class="nearby-card-dot">&middot;</span><span>' + escapeHtml(store.deliveryTime) + "</span>"
            : "") +
          '<span class="nearby-card-dot">&middot;</span>' +
          feeLabel +
          "</div>" +
          "</div>" +
          "</a>"
        );
      })
      .join("");
  }

  function renderProvidersNearby() {
    var escapeHtml = window.appDatabase.escapeHtml;
    var query = state.search.trim().toLowerCase();

    var fetchPromise = providersCache
      ? Promise.resolve(providersCache)
      : fetch("/api/providers")
          .then(function (response) {
            return response.json();
          })
          .then(function (data) {
            providersCache = data.providers || [];
            return providersCache;
          })
          .catch(function () {
            return [];
          });

    if (!providersCache) {
      nearbyListEl.innerHTML = '<div class="nearby-empty">Carregando prestadores...</div>';
    }

    var TAXI_CARD_HTML =
      '<a class="nearby-card" href="./pedir-corrida.html">' +
      '<div class="nearby-card-avatar nearby-card-avatar-icon nearby-card-avatar-accent">' +
      '<i class="fas fa-taxi"></i>' +
      "</div>" +
      '<div class="nearby-card-body">' +
      "<strong>Táxi</strong>" +
      '<div class="nearby-card-meta">' +
      '<span class="nearby-card-status is-open">Chamar agora</span>' +
      '<span class="nearby-card-dot">&middot;</span>' +
      "<span>Valor fechado na hora, motorista perto de você</span>" +
      "</div>" +
      "</div>" +
      "</a>";
    // Mostra o card de táxi fixo no topo da aba Serviços - some só quando o
    // cliente está buscando por outra coisa específica (ex.: "eletricista").
    var showTaxiCard =
      !query || "táxi".indexOf(query) >= 0 || "taxi".indexOf(query) >= 0 || "corrida".indexOf(query) >= 0;

    fetchPromise.then(function (providers) {
      var filtered = providers.filter(function (provider) {
        if (!query) {
          return true;
        }

        var haystack = (provider.name + " " + (provider.specialty || "")).toLowerCase();
        return haystack.indexOf(query) >= 0;
      });

      if (!filtered.length) {
        nearbyListEl.innerHTML =
          (showTaxiCard ? TAXI_CARD_HTML : "") + '<div class="nearby-empty">Nenhum prestador encontrado.</div>';
        return;
      }

      nearbyListEl.innerHTML =
        (showTaxiCard ? TAXI_CARD_HTML : "") +
        filtered
          .map(function (provider) {
          var ratingLabel = provider.avgRating != null ? Number(provider.avgRating).toFixed(1) : "Novo";

          return (
            '<a class="nearby-card" href="./solicitar-orcamento.html?provider=' +
            encodeURIComponent(provider.id) +
            '">' +
            '<div class="nearby-card-avatar nearby-card-avatar-icon">' +
            '<i class="fas fa-screwdriver-wrench"></i>' +
            "</div>" +
            '<div class="nearby-card-body">' +
            "<strong>" +
            escapeHtml(provider.name) +
            "</strong>" +
            '<div class="nearby-card-meta">' +
            '<span class="nearby-card-rating"><i class="fas fa-star"></i>' +
            ratingLabel +
            "</span>" +
            '<span class="nearby-card-dot">&middot;</span>' +
            "<span>" +
            escapeHtml(provider.specialty || "Prestador de serviço") +
            "</span>" +
            '<span class="nearby-card-dot">&middot;</span>' +
            '<span class="nearby-card-status' +
            (provider.isAvailable ? " is-open" : "") +
            '">' +
            (provider.isAvailable ? "Disponível" : "Indisponível") +
            "</span>" +
            (provider.antecedentesVerified
              ? '<span class="nearby-card-dot">&middot;</span>' +
                '<span class="nearby-card-verified-badge"><i class="fas fa-shield-halved"></i>Antecedentes verificados</span>'
              : "") +
            "</div>" +
            "</div>" +
            "</a>"
          );
        })
        .join("");
    });
  }

  function renderNearby(data) {
    if (state.tab === "servicos") {
      nearbyTitleEl.textContent = "Prestadores perto de você";
      nearbySeeAllEl.setAttribute("href", "./solicitar-orcamento.html");
      renderProvidersNearby();
      return;
    }

    var activeGroupChip = state.categoryView !== "root" ? getChipById(state.categoryView) : null;
    if (activeGroupChip) {
      nearbyTitleEl.textContent = activeGroupChip.label + " perto de você";
      nearbySeeAllEl.setAttribute("href", chipHref(activeGroupChip));
    } else {
      nearbyTitleEl.textContent = "Perto de você";
      nearbySeeAllEl.setAttribute("href", "./category.html?category=comida");
    }
    renderStoresNearby(data);
  }

  function setTab(tab) {
    if (state.tab === tab) {
      return;
    }

    state.tab = tab;
    state.search = "";
    state.categoryView = "root";
    searchInputEl.value = "";

    tabButtons.forEach(function (button) {
      button.classList.toggle("active", button.dataset.tab === tab);
    });

    searchInputEl.placeholder =
      tab === "servicos" ? "Busque prestadores de serviço" : "Busque lojas, comida ou serviços";

    render();
  }

  function bindEvents() {
    tabButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        setTab(button.dataset.tab);
      });
    });

    categoriesEl.addEventListener("click", function (event) {
      var expandButton = event.target.closest('[data-action="expand"]');
      var backButton = event.target.closest('[data-action="back-to-root"]');

      if (expandButton) {
        state.categoryView = expandButton.dataset.expand;
        render();
        return;
      }

      if (backButton) {
        state.categoryView = "root";
        render();
      }
    });

    addressButtonEl.addEventListener("click", function () {
      window.location.href = "./enderecos.html";
    });

    if (backButtonEl) {
      backButtonEl.addEventListener("click", function () {
        if (window.history.length > 1) {
          window.history.back();
        }
      });
    }

    searchFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      var query = searchInputEl.value.trim();

      if (!query) {
        return;
      }

      if (state.tab === "servicos") {
        state.search = query;
        render();
        return;
      }

      window.location.href = "./category.html?category=comida&search=" + encodeURIComponent(query);
    });

    searchInputEl.addEventListener("input", function () {
      state.search = searchInputEl.value.trim();
      render();
    });
  }

  function render() {
    var data = getData();
    renderAddress();
    renderCategories(data);
    renderNearby(data);
  }

  bindEvents();
  loadHomeChips();
  window.appDatabase.syncCatalogFromServer().finally(render);
})();