(function itemPage() {
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

  var storeNameEl = document.getElementById("item-store-name");
  var heroEl = document.getElementById("item-detail-hero");
  var titleEl = document.getElementById("item-detail-title");
  var priceEl = document.getElementById("item-detail-price");
  var descriptionEl = document.getElementById("item-detail-description");
  var messageEl = document.getElementById("item-detail-message");
  var addButtonEl = document.getElementById("item-add-cart-button");
  var ratingSummaryEl = document.getElementById("item-rating-summary");
  var reviewsSectionEl = document.getElementById("item-reviews-section");

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

  function getItemDescription(item, store) {
    if (item.description) {
      return item.description;
    }

    var section = item.section ? item.section.toLowerCase() : "item";
    return (
      item.name +
      " da loja " +
      store.name +
      ". Consulte disponibilidade e adicione ao carrinho para continuar seu pedido."
    );
  }

  function renderStars(rating) {
    var rounded = Math.round(Number(rating) || 0);
    var stars = "";
    for (var i = 1; i <= 5; i += 1) {
      stars += '<i class="fas fa-star' + (i > rounded ? " star-empty" : "") + '"></i>';
    }
    return stars;
  }

  function renderItemRatingSummary(reviewsData) {
    if (!ratingSummaryEl) {
      return;
    }

    var reviewsCount = (reviewsData && reviewsData.reviewsCount) || 0;

    if (!reviewsCount) {
      ratingSummaryEl.innerHTML =
        '<div class="store-rating-summary-top"><span>Item ainda sem avaliações de clientes</span></div>';
      return;
    }

    ratingSummaryEl.innerHTML =
      '<div class="store-rating-summary-top">' +
      renderStars(reviewsData.averageRating) +
      "<strong>" +
      Number(reviewsData.averageRating || 0).toFixed(1) +
      "</strong>" +
      "<span>" +
      reviewsCount +
      (reviewsCount === 1 ? " avaliação" : " avaliações") +
      "</span>" +
      "</div>";
  }

  function renderItemReviews(reviewsData) {
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
      '<div class="section-header"><h2>Comentários sobre este item</h2></div>' +
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
            (review.comment ? "<p>" + escapeHtml(review.comment) + "</p>" : "") +
            "</div>"
          );
        })
        .join("") +
      "</div>";
  }

  function loadItemReviews() {
    window.appDatabase.getItemReviews(itemId).then(function (reviewsData) {
      renderItemRatingSummary(reviewsData);
      renderItemReviews(reviewsData);
    });
  }

  function render() {
    var store = window.appDatabase.getStoreById(storeId);
    var item = store && store.items
      ? store.items.find(function (entry) {
          return entry.id === itemId;
        })
      : null;

    if (!store || !item) {
      window.location.href = "./home.html";
      return;
    }

    document.title = item.name + " - Alloo";
    storeNameEl.textContent = store.name;
    titleEl.textContent = item.name;
    if (
      item.promoPrice != null &&
      Number(item.promoPrice) > 0 &&
      Number(item.promoPrice) < Number(item.price || 0)
    ) {
      priceEl.innerHTML =
        '<span class="item-detail-price-old">' +
        window.appDatabase.formatMoney(Number(item.price || 0)) +
        '</span><span class="item-detail-price-sale">' +
        window.appDatabase.formatMoney(Number(item.promoPrice || 0)) +
        "</span>";
    } else {
      priceEl.textContent = window.appDatabase.formatMoney(Number(item.price || 0));
    }
    descriptionEl.textContent = getItemDescription(item, store);
    var safePhotoUrl = window.appDatabase.sanitizeUrl(item.photoUrl);
    heroEl.innerHTML = safePhotoUrl
      ? '<img class="item-detail-image" src="' +
        safePhotoUrl +
        '" alt="' +
        window.appDatabase.escapeHtml(item.name) +
        '" />'
      : '<div class="item-detail-fallback">' + getItemEmoji(item, store) + "</div>";

    addButtonEl.disabled =
      store.isActive === false || item.available === false || !window.appDatabase.isStoreOpen(store);

    addButtonEl.textContent = addButtonEl.disabled
      ? "Item indisponível no momento"
      : "Adicionar ao carrinho";

    addButtonEl.onclick = function () {
      var currentCart = window.appDatabase.getCartDetailed();
      var replacingStore =
        currentCart.store && currentCart.store.id && currentCart.store.id !== store.id;
      var result = window.appDatabase.addItemToCart(store.id, item.id);

      if (!result) {
        messageEl.textContent = "Este item não está disponível agora.";
        return;
      }

      messageEl.textContent = replacingStore
        ? "Carrinho trocado para a loja atual e item adicionado."
        : "Item adicionado ao carrinho.";
    };
  }

  window.appDatabase.syncCatalogFromServer().finally(render);
  loadItemReviews();
})();
