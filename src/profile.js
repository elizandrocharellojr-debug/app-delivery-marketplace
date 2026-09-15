(function profilePage() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  var logoutButtonEl = document.getElementById("customer-logout-button");
  var menuButtonEl = document.getElementById("profile-menu-button");
  var paymentToggleEl = document.getElementById("payment-info-toggle");
  var paymentNoteEl = document.getElementById("payment-info-note");
  var avatarEl = document.getElementById("profile-avatar");
  var heroNameEl = document.getElementById("profile-hero-name");
  var heroEmailEl = document.getElementById("profile-hero-email");
  var loyaltyPointsEl = document.getElementById("loyalty-points-text");

  var LOYALTY_TIER_SIZE = 200;

  function fillHero() {
    var session = window.appDatabase.getCustomerSession();
    var profile = window.appDatabase.getProfile();
    var name = (profile && profile.name) || (session && session.customerName) || "Cliente";
    var email = (session && session.email) || "";

    heroNameEl.textContent = name;
    heroEmailEl.textContent = email;
    avatarEl.textContent = name.trim().charAt(0).toUpperCase() || "?";
  }

  function fillLoyalty() {
    var orders = window.appDatabase.getOrders();
    var points = orders.reduce(function (total, order) {
      if (order.status === "Cancelado") {
        return total;
      }
      return total + Math.round(Number(order.total) || 0);
    }, 0);

    var nextTier = (Math.floor(points / LOYALTY_TIER_SIZE) + 1) * LOYALTY_TIER_SIZE;
    var remaining = nextTier - points;

    loyaltyPointsEl.textContent =
      points + " pontos · faltam " + remaining + " pro cupom";
  }

  logoutButtonEl.addEventListener("click", function () {
    window.appDatabase.clearCustomerSession();
    window.location.href = "./index.html";
  });

  if (menuButtonEl) {
    menuButtonEl.addEventListener("click", function () {
      if (window.confirm("Sair da sua conta?")) {
        window.appDatabase.clearCustomerSession();
        window.location.href = "./index.html";
      }
    });
  }

  if (paymentToggleEl && paymentNoteEl) {
    paymentToggleEl.addEventListener("click", function () {
      paymentNoteEl.hidden = !paymentNoteEl.hidden;
    });
  }

  fillHero();
  fillLoyalty();
})();
