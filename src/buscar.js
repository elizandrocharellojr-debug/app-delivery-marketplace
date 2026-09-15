(function buscarPage() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  var CATEGORIES = [
    { label: "Lanches", icon: "fa-burger", group: "comida", search: "Lanches" },
    { label: "Pizza", icon: "fa-pizza-slice", group: "comida", search: "Pizza" },
    { label: "Marmita", icon: "fa-bowl-food", group: "comida", search: "Marmita" },
    { label: "Mercado", icon: "fa-cart-shopping", group: "comida", category: "mercados-farmacias" },
    { label: "Mecânico", icon: "fa-screwdriver-wrench", group: "servicos", specialty: "mecânico" },
    { label: "Pedreiro", icon: "fa-trowel-bricks", group: "servicos", specialty: "pedreiro" },
    { label: "Manicure", icon: "fa-hand-sparkles", group: "servicos", specialty: "manicure" },
    { label: "Eletricista", icon: "fa-bolt", group: "servicos", specialty: "eletricista" },
  ];

  var formEl = document.getElementById("buscar-form");
  var inputEl = document.getElementById("buscar-input");
  var categoriesSectionEl = document.getElementById("buscar-categories-section");
  var categoryGridEl = document.getElementById("buscar-category-grid");
  var resultsSectionEl = document.getElementById("buscar-results-section");
  var resultsTitleEl = document.getElementById("buscar-results-title");
  var clearLinkEl = document.getElementById("buscar-clear-link");
  var resultsStoresEl = document.getElementById("buscar-results-stores");
  var resultsProvidersEl = document.getElementById("buscar-results-providers");

  var providersCache = null;

  function fetchProviders() {
    if (providersCache) {
      return Promise.resolve(providersCache);
    }

    return fetch("/api/providers")
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
  }

  function moneyLabel(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function renderCategoryGrid() {
    categoryGridEl.innerHTML = CATEGORIES.map(function (category, index) {
      return (
        '<button type="button" class="buscar-category-card" data-index="' +
        index +
        '">' +
        '<span class="buscar-category-icon"><i class="fas ' +
        category.icon +
        '"></i></span>' +
        '<span class="buscar-category-copy">' +
        "<strong>" +
        category.label +
        "</strong>" +
        "<span>" +
        (category.group === "servicos" ? "Serviços" : "Comida") +
        "</span>" +
        "</span>" +
        "</button>"
      );
    }).join("");

    categoryGridEl.querySelectorAll(".buscar-category-card").forEach(function (card) {
      card.addEventListener("click", function () {
        var category = CATEGORIES[Number(card.dataset.index)];
        openCategory(category);
      });
    });
  }

  function showCategories() {
    categoriesSectionEl.hidden = false;
    resultsSectionEl.hidden = true;
  }

  function showResults(title) {
    categoriesSectionEl.hidden = true;
    resultsSectionEl.hidden = false;
    resultsTitleEl.textContent = title;
  }

  function renderStoreCards(stores) {
    var escapeHtml = window.appDatabase.escapeHtml;
    var sanitizeUrl = window.appDatabase.sanitizeUrl;

    if (!stores.length) {
      resultsStoresEl.innerHTML = "";
      return;
    }

    resultsStoresEl.innerHTML =
      '<div class="section-header"><h2>Estabelecimentos</h2></div><div class="nearby-list">' +
      stores
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
        .join("") +
      "</div>";
  }

  function renderProviderCards(providers) {
    var escapeHtml = window.appDatabase.escapeHtml;

    if (!providers.length) {
      resultsProvidersEl.innerHTML = "";
      return;
    }

    resultsProvidersEl.innerHTML =
      '<div class="section-header"><h2>Prestadores de serviço</h2></div><div class="nearby-list">' +
      providers
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
        .join("") +
      "</div>";
  }

  function renderEmptyIfNeeded(stores, providers) {
    if (!stores.length && !providers.length) {
      resultsStoresEl.innerHTML = '<div class="nearby-empty">Nada encontrado. Tente outra busca.</div>';
      resultsProvidersEl.innerHTML = "";
    }
  }

  function searchStores(query) {
    var normalized = query.trim().toLowerCase();
    var stores = window.appDatabase.load().stores.filter(function (store) {
      return store.isActive !== false && store.categoryId !== "servicos";
    });

    if (!normalized) {
      return stores;
    }

    return stores.filter(function (store) {
      var haystack = [
        store.name,
        store.description,
        store.coverLabel,
        (store.tags || []).join(" "),
        store.items.map(function (item) { return item.name; }).join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.indexOf(normalized) >= 0;
    });
  }

  function searchProviders(query, providers) {
    var normalized = query.trim().toLowerCase();

    if (!normalized) {
      return providers;
    }

    return providers.filter(function (provider) {
      var haystack = (provider.name + " " + (provider.specialty || "")).toLowerCase();
      return haystack.indexOf(normalized) >= 0;
    });
  }

  function runTextSearch(query) {
    showResults('Resultados para "' + query + '"');
    clearLinkEl.textContent = "Categorias";

    var stores = searchStores(query);
    renderStoreCards(stores.slice(0, 10));

    fetchProviders().then(function (providers) {
      var filteredProviders = searchProviders(query, providers);
      renderProviderCards(filteredProviders);
      renderEmptyIfNeeded(stores, filteredProviders);
    });
  }

  function openCategory(category) {
    if (category.group === "comida") {
      if (category.category) {
        window.location.href = "./category.html?category=" + category.category;
        return;
      }

      window.location.href = "./category.html?category=comida&search=" + encodeURIComponent(category.search);
      return;
    }

    showResults(category.label);
    clearLinkEl.textContent = "Categorias";
    resultsStoresEl.innerHTML = '<div class="nearby-empty">Carregando...</div>';
    resultsProvidersEl.innerHTML = "";

    fetchProviders().then(function (providers) {
      var filtered = providers.filter(function (provider) {
        return (provider.specialty || "").toLowerCase().indexOf(category.specialty) >= 0;
      });

      resultsStoresEl.innerHTML = "";

      if (!filtered.length) {
        resultsProvidersEl.innerHTML =
          '<div class="nearby-empty">Nenhum prestador de ' + category.label + " por aqui ainda.</div>";
        return;
      }

      renderProviderCards(filtered);
    });
  }

  function bindEvents() {
    formEl.addEventListener("submit", function (event) {
      event.preventDefault();
    });

    inputEl.addEventListener("input", function () {
      var query = inputEl.value.trim();

      if (!query) {
        showCategories();
        return;
      }

      runTextSearch(query);
    });

    clearLinkEl.addEventListener("click", function (event) {
      event.preventDefault();
      inputEl.value = "";
      showCategories();
    });
  }

  renderCategoryGrid();
  bindEvents();
})();