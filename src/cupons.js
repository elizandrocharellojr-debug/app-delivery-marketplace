(function cuponsPage() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  var listEl = document.getElementById("cupons-list");

  function moneyLabel(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function discountLabel(coupon) {
    if (coupon.type === "fixed") {
      return moneyLabel(coupon.value) + " de desconto";
    }

    return Number(coupon.value) + "% de desconto";
  }

  function render(coupons) {
    if (!coupons.length) {
      listEl.innerHTML = '<div class="empty-state">Nenhum cupom ativo no momento. Volte aqui mais tarde.</div>';
      return;
    }

    listEl.innerHTML = coupons
      .map(function (coupon) {
        return (
          '<a class="customer-coupon-card" href="./store.html?store=' +
          coupon.storeId +
          '">' +
          '<div class="customer-coupon-card-icon"><i class="fas fa-ticket"></i></div>' +
          '<div class="customer-coupon-card-body">' +
          "<strong>" +
          coupon.code +
          "</strong>" +
          "<span>" +
          discountLabel(coupon) +
          (coupon.minOrder > 0 ? " em pedidos acima de " + moneyLabel(coupon.minOrder) : "") +
          "</span>" +
          "<span class=\"customer-coupon-card-store\">" + coupon.storeName + "</span>" +
          "</div>" +
          "</a>"
        );
      })
      .join("");
  }

  fetch("/api/coupons/active")
    .then(function (response) {
      return response.json();
    })
    .then(function (data) {
      render(data.coupons || []);
    })
    .catch(function () {
      listEl.innerHTML = '<div class="empty-state">Não foi possível carregar os cupons agora.</div>';
    });
})();
