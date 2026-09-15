(function favoritesPage() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  var listEl = document.getElementById("favorites-list");

  function render() {
    var favoriteIds = window.appDatabase.getFavorites();
    var stores = favoriteIds
      .map(function (storeId) {
        return window.appDatabase.getStoreById(storeId);
      })
      .filter(Boolean);

    if (!stores.length) {
      listEl.innerHTML =
        '<div class="empty-state">Você ainda não favoritou nenhuma loja. Toque no coração na página da loja para adicionar.</div>';
      return;
    }

    var escapeHtml = window.appDatabase.escapeHtml;

    listEl.innerHTML = stores
      .map(function (store) {
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
          Number(store.reviewsCount > 0 ? store.avgRating : store.rating).toFixed(1) +
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

  window.addEventListener("storage", render);
  window.appDatabase.syncCatalogFromServer().finally(render);
})();
