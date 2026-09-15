(function cartFloatingHandler() {
  var floatingButtonEl = document.getElementById("global-floating-cart-button");
  var floatingCountEl = document.getElementById("global-floating-cart-count");

  if (!floatingButtonEl || !floatingCountEl || !window.appDatabase) {
    return;
  }

  function renderFloatingCart() {
    var cart = window.appDatabase.getCartDetailed();

    if (!cart.store || !cart.items.length) {
      floatingButtonEl.classList.add("hidden");
      return;
    }

    floatingCountEl.textContent = String(cart.totalItems || 0);
    floatingButtonEl.classList.remove("hidden");
  }

  window.addEventListener("storage", renderFloatingCart);
  window.setInterval(renderFloatingCart, 2000);
  renderFloatingCart();
})();
