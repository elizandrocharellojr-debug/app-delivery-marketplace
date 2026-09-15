(function categoryPage() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  var params = new URLSearchParams(window.location.search);
  var categoryId = params.get("category") || "comida";
  var subCategory = params.get("sub") || "";
  // "from" vem preenchido quando a página foi aberta a partir de um ícone
  // dentro de um grupo expandido na Home (ex: Comida > Pizza). Nesse caso o
  // botão de voltar deve retornar pra Home já naquele grupo aberto, em vez
  // de voltar pra tela raiz.
  var fromExpand = params.get("from") || "";
  var state = {
    search: params.get("search") || "",
  };

  var SUB_CATEGORY_TITLES = {
    mercado: "Mercados",
    farmacia: "Farmácias",
  };

  var titleEl = document.getElementById("category-title");
  var listTitleEl = document.getElementById("list-title");
  var resultsCountEl = document.getElementById("category-results-count");
  var storeListEl = document.getElementById("category-store-list");
  var searchFormEl = document.getElementById("category-search-form");
  var searchInputEl = document.getElementById("category-search-input");
  var backButtonEl = document.getElementById("category-back-button");
  var refreshTimer = null;

  if (backButtonEl && fromExpand) {
    backButtonEl.setAttribute("href", "./home.html?expand=" + encodeURIComponent(fromExpand));
  }

  function getCategory() {
    return window.appDatabase.getCategoryById(categoryId);
  }

  function getStores() {
    var stores = window.appDatabase.getStoresByCategory(categoryId);

    if (subCategory) {
      stores = stores.filter(function (store) {
        return store.subCategory === subCategory;
      });
    }

    var normalized = state.search.trim().toLowerCase();

    if (!normalized) {
      return stores;
    }

    return stores.filter(function (store) {
      var haystack = [
        store.name,
        store.description,
        store.coverLabel,
        store.tags.join(" "),
        store.items
          .map(function (item) {
            return item.name;
          })
          .join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.indexOf(normalized) >= 0;
    });
  }

  function renderHeader(category) {
    var displayName = SUB_CATEGORY_TITLES[subCategory] || category.name;
    document.title = displayName + " - Alloo";
    titleEl.textContent = displayName;
    listTitleEl.textContent = displayName;
  }

  function renderStores() {
    var stores = getStores();
    resultsCountEl.textContent = "";

    if (!stores.length) {
      storeListEl.innerHTML =
        '<div class="empty-state">Nenhuma loja encontrada nessa categoria.</div>';
      return;
    }

    storeListEl.innerHTML = stores
      .map(function (store) {
        var escapeHtml = window.appDatabase.escapeHtml;
        var safeLogoUrl = window.appDatabase.sanitizeUrl(store.logoUrl);
        return (
          '<a class="store-card-large category-store-card" href="./store.html?store=' +
          store.id +
          '">' +
          '<div class="store-card-top">' +
          '<div class="store-badge">' +
          (safeLogoUrl
            ? '<img class="store-logo-image" src="' + safeLogoUrl + '" alt="' + escapeHtml(store.name) + '" />'
            : store.icon) +
          "</div>" +
          '<div class="store-copy">' +
          "<h3>" +
          escapeHtml(store.name) +
          "</h3>" +
          "</div>" +
          '<div class="category-store-rating">' +
          '<i class="fas fa-star"></i>' +
          "<strong>" +
          store.rating.toFixed(1) +
          "</strong>" +
          "</div>" +
          "</div>" +
          '<div class="store-info-row category-store-meta">' +
          '<span><i class="fas fa-motorcycle"></i> ' +
          store.deliveryFee +
          "</span>" +
          "</div>" +
          "</a>"
        );
      })
      .join("");
  }

  function bindEvents() {
    searchFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      state.search = searchInputEl.value.trim();
      renderStores();
    });

    searchInputEl.addEventListener("input", function () {
      state.search = searchInputEl.value.trim();
      renderStores();
    });
  }

  function init() {
    var category = getCategory();

    if (!category) {
      window.location.href = "./index.html";
      return;
    }

    if (state.search) {
      searchInputEl.value = state.search;
    }

    renderHeader(category);
    renderStores();
    bindEvents();
  }

  function refreshCategory() {
    var category = getCategory();

    if (!category) {
      window.location.href = "./home.html";
      return;
    }

    renderHeader(category);
    renderStores();
  }

  window.addEventListener("storage", refreshCategory);
  refreshTimer = window.setInterval(function () {
    window.appDatabase.syncCatalogFromServer().finally(refreshCategory);
  }, 2000);

  window.appDatabase.syncCatalogFromServer().finally(init);
})();
