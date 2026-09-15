(function storePage() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  var params = new URLSearchParams(window.location.search);
  var storeId = params.get("store");
  var itemId = params.get("item");

  var titleEl = document.getElementById("store-title");
  var iconEl = document.getElementById("store-icon");
  var nameEl = document.getElementById("store-name");
  var descriptionEl = document.getElementById("store-description");
  var hoursEl = document.getElementById("store-hours");
  var timeEl = document.getElementById("store-time");
  var feeEl = document.getElementById("store-fee");
  var minOrderEl = document.getElementById("store-min-order");
  var itemsListEl = document.getElementById("store-items-list");
  var messageEl = document.getElementById("store-message");
  var favoriteButtonEl = document.getElementById("favorite-button");
  var storeStatusBadgeEl = document.getElementById("store-status-badge");
  var floatingCartButtonEl = document.getElementById("store-cart-floating-button");
  var floatingCartCountEl = document.getElementById("store-cart-floating-count");
  var itemSearchInputEl = document.getElementById("store-item-search-input");
  var ratingSummaryEl = document.getElementById("store-rating-summary");
  var reviewsSectionEl = document.getElementById("store-reviews-section");
  var socialLinksEl = document.getElementById("store-social-links");
  var refreshTimer = null;
  var itemSearch = "";

  function getItemEmoji(item, store) {
    var name = String(item.name || "").toLowerCase();
    var section = String(item.section || "").toLowerCase();
    var category = String(store.categoryId || "").toLowerCase();

    if (name.indexOf("pizza") >= 0) return "🍕";
    if (name.indexOf("pastel") >= 0) return "🥟";
    if (name.indexOf("barreado") >= 0 || name.indexOf("caldo") >= 0) return "🍲";
    if (name.indexOf("arroz") >= 0) return "🍚";
    if (name.indexOf("banana") >= 0) return "🍌";
    if (name.indexOf("x-") >= 0 || name.indexOf("hamb") >= 0) return "🍔";
    if (name.indexOf("suco") >= 0 || name.indexOf("refrigerante") >= 0) return "🥤";
    if (category === "mercados-farmacias" && section.indexOf("medic") >= 0) return "💊";
    if (category === "mercados-farmacias" && section.indexOf("higiene") >= 0) return "🧴";
    if (category === "mercados-farmacias" && section.indexOf("hortifruti") >= 0) return "🥬";
    if (category === "mercados-farmacias" && section.indexOf("mercearia") >= 0) return "🛒";

    return store.icon || "🍽";
  }

  function getItemThumbMarkup(item, store) {
    var safePhotoUrl = window.appDatabase.sanitizeUrl(item.photoUrl);
    if (safePhotoUrl) {
      return (
        '<img class="item-thumb-image" src="' +
        safePhotoUrl +
        '" alt="' +
        window.appDatabase.escapeHtml(item.name) +
        '" />'
      );
    }

    return '<div class="item-thumb-fallback">' + getItemEmoji(item, store) + "</div>";
  }

  function renderStore(store) {
    var isOpen = window.appDatabase.isStoreOpen(store);
    var isActive = store.isActive !== false;
    var statusLabel = !isActive
      ? "Loja indisponível"
      : isOpen
      ? "Loja aberta agora"
      : "Fora do horário";
    document.title = store.name + " - Morretes Delivery";
    titleEl.textContent = store.name;
    var safeLogoUrl = window.appDatabase.sanitizeUrl(store.logoUrl);
    iconEl.innerHTML = safeLogoUrl
      ? '<img class="store-logo-image" src="' +
        safeLogoUrl +
        '" alt="' +
        window.appDatabase.escapeHtml(store.name) +
        '" />'
      : store.icon;
    nameEl.textContent = store.name;
    descriptionEl.textContent = "";
    descriptionEl.style.display = "none";
    storeStatusBadgeEl.textContent = statusLabel;
    storeStatusBadgeEl.classList.toggle("closed", !isOpen);
    hoursEl.textContent = "";
    hoursEl.style.display = "none";
    timeEl.textContent = "";
    timeEl.style.display = "none";
    feeEl.textContent = "";
    feeEl.style.display = "none";
    minOrderEl.textContent = "";
    minOrderEl.style.display = "none";

    favoriteButtonEl.classList.toggle("active", window.appDatabase.isFavorite(store.id));

    messageEl.textContent = !isActive
      ? "Esta loja está inativa no momento."
      : isOpen
      ? ""
      : "Loja ativa, mas fora do horário de funcionamento.";

    var normalizedSearch = itemSearch.trim().toLowerCase();
    var grouped = {};
    store.items
      .filter(function (item) {
        if (item.available === false) {
          return false;
        }
        if (!normalizedSearch) {
          return true;
        }
        return String(item.name || "").toLowerCase().indexOf(normalizedSearch) >= 0;
      })
      .forEach(function (item) {
        var section = item.section || "Geral";
        if (!grouped[section]) {
          grouped[section] = [];
        }
        grouped[section].push(item);
      });

    itemsListEl.innerHTML = Object.keys(grouped)
      .map(function (section) {
        return (
          '<section class="menu-section">' +
          '<div class="section-header"><h2>' +
          window.appDatabase.escapeHtml(section) +
          "</h2></div>" +
          grouped[section]
            .map(function (item) {
              var activeClass = item.id === itemId ? "active" : "";
              return (
                '<a class="item-card item-link-card ' +
                activeClass +
                '" id="' +
                item.id +
                '" href="./item.html?store=' +
                store.id +
                "&item=" +
                item.id +
                '">' +
                '<div class="item-thumb">' +
                getItemThumbMarkup(item, store) +
                "</div>" +
                '<div class="item-card-top">' +
                "<div>" +
                "<strong>" +
                window.appDatabase.escapeHtml(item.name) +
                "</strong>" +
                "<p>" +
                window.appDatabase.escapeHtml(item.description || "Disponível para pedido") +
                "</p>" +
                "</div>" +
                '<span class="item-card-price">' +
                (item.promoPrice != null &&
                Number(item.promoPrice) > 0 &&
                Number(item.promoPrice) < Number(item.price)
                  ? '<span class="item-card-price-old">' +
                    window.appDatabase.formatMoney(item.price) +
                    '</span><span class="item-card-price-sale">' +
                    window.appDatabase.formatMoney(item.promoPrice) +
                    "</span>"
                  : window.appDatabase.formatMoney(item.price)) +
                "</span>" +
                "</div>" +
                "</a>"
              );
            })
            .join("") +
          "</section>"
        );
      })
      .join("");

    if (!Object.keys(grouped).length) {
      itemsListEl.innerHTML = normalizedSearch
        ? '<div class="empty-state">Nenhum item encontrado com esse nome.</div>'
        : '<div class="empty-state">Essa loja ainda não cadastrou itens.</div>';
    }

    if (itemId) {
      var activeItem = document.getElementById(itemId);
      if (activeItem) {
        activeItem.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    renderRatingSummary(store);
    renderSocialLinks(store);
    renderFloatingCart();
    bindStoreEvents(store);
  }

  // Só mostra o ícone de cada rede se a loja tiver preenchido o link dela -
  // sem Instagram/Facebook cadastrado, a linha inteira some (nada de ícone
  // "vazio" ou quebrado).
  function renderSocialLinks(store) {
    if (!socialLinksEl) {
      return;
    }

    var links = [];
    var instagramUrl = window.appDatabase.sanitizeUrl(store.instagramUrl);
    var facebookUrl = window.appDatabase.sanitizeUrl(store.facebookUrl);

    if (instagramUrl) {
      links.push(
        '<a class="store-social-link" href="' +
          instagramUrl +
          '" target="_blank" rel="noopener noreferrer" aria-label="Instagram da loja">' +
          '<i class="fab fa-instagram"></i></a>'
      );
    }

    if (facebookUrl) {
      links.push(
        '<a class="store-social-link" href="' +
          facebookUrl +
          '" target="_blank" rel="noopener noreferrer" aria-label="Facebook da loja">' +
          '<i class="fab fa-facebook"></i></a>'
      );
    }

    socialLinksEl.innerHTML = links.join("");
    socialLinksEl.hidden = links.length === 0;
  }

  function renderStars(rating) {
    var rounded = Math.round(Number(rating) || 0);
    var stars = "";
    for (var i = 1; i <= 5; i += 1) {
      stars += '<i class="fas fa-star' + (i > rounded ? " star-empty" : "") + '"></i>';
    }
    return stars;
  }

  function renderRatingSummary(store) {
    if (!ratingSummaryEl) {
      return;
    }

    var hasReviews = store.reviewsCount > 0;
    var displayRating = hasReviews ? store.avgRating : store.rating;

    ratingSummaryEl.innerHTML =
      '<div class="store-rating-summary-top">' +
      renderStars(displayRating) +
      "<strong>" +
      Number(displayRating || 0).toFixed(1) +
      "</strong>" +
      "<span>" +
      (hasReviews
        ? store.reviewsCount + (store.reviewsCount === 1 ? " avaliação" : " avaliações")
        : "Loja ainda sem avaliações de clientes") +
      "</span>" +
      "</div>";
  }

  function renderReviews(reviewsData) {
    if (!reviewsSectionEl) {
      return;
    }

    var reviews = (reviewsData && reviewsData.reviews) || [];
    var escapeHtml = window.appDatabase.escapeHtml;

    if (!reviews.length) {
      reviewsSectionEl.innerHTML = "";
      return;
    }

    reviewsSectionEl.innerHTML =
      '<div class="section-header"><h2>O que os clientes acharam</h2></div>' +
      '<div class="store-reviews-list">' +
      reviews
        .slice(0, 10)
        .map(function (review) {
          return (
            '<div class="store-review-card">' +
            '<div class="store-review-top">' +
            renderStars(review.rating) +
            "<strong>" +
            escapeHtml(review.customerName) +
            "</strong>" +
            "</div>" +
            (review.comment
              ? "<p>" + escapeHtml(review.comment) + "</p>"
              : "") +
            "</div>"
          );
        })
        .join("") +
      "</div>";
  }

  function renderFloatingCart() {
    var cart = window.appDatabase.getCartDetailed();

    if (!floatingCartButtonEl || !floatingCartCountEl) {
      return;
    }

    if (!cart.store || !cart.items.length) {
      floatingCartButtonEl.classList.add("hidden");
      return;
    }

    floatingCartCountEl.textContent = String(cart.totalItems || 0);
    floatingCartButtonEl.classList.remove("hidden");
  }

  function bindStoreEvents(store) {
    favoriteButtonEl.addEventListener("click", function () {
      window.appDatabase.toggleFavorite(store.id);
      favoriteButtonEl.classList.toggle("active", window.appDatabase.isFavorite(store.id));
      messageEl.textContent = window.appDatabase.isFavorite(store.id)
        ? "Loja adicionada aos favoritos."
        : "Loja removida dos favoritos.";
    });
  }

  function init() {
    var store = window.appDatabase.getStoreById(storeId);

    if (!store) {
      window.location.href = "./index.html";
      return;
    }

    renderStore(store);
  }

  function refreshStore() {
    var latestStore = window.appDatabase.getStoreById(storeId);

    if (!latestStore) {
      window.location.href = "./home.html";
      return;
    }

    renderStore(latestStore);
  }

  if (itemSearchInputEl) {
    itemSearchInputEl.addEventListener("input", function () {
      itemSearch = itemSearchInputEl.value;
      var currentStore = window.appDatabase.getStoreById(storeId);
      if (currentStore) {
        renderStore(currentStore);
        itemSearchInputEl.focus();
      }
    });
  }

  window.appDatabase.getStoreReviews(storeId).then(renderReviews);

  window.addEventListener("storage", refreshStore);
  refreshTimer = window.setInterval(function () {
    window.appDatabase.syncCatalogFromServer().finally(refreshStore);
  }, 2000);

  window.appDatabase.syncCatalogFromServer().finally(init);
})();
