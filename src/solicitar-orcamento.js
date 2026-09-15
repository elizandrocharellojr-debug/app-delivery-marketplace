(function budgetRequestPage() {
  var formEl = document.getElementById("budget-request-form");
  var providerSelectEl = document.getElementById("provider-select");
  var verifiedBadgeEl = document.getElementById("provider-verified-badge");
  var nameEl = document.getElementById("customer-name-input");
  var phoneEl = document.getElementById("customer-phone-input");
  var locationEl = document.getElementById("location-input");
  var messageEl = document.getElementById("message-input");
  var feedbackEl = document.getElementById("budget-request-message");
  var preselectedProviderId = new URLSearchParams(window.location.search).get("provider") || "";
  var providersById = {};

  function updateVerifiedBadge() {
    var provider = providersById[providerSelectEl.value];
    verifiedBadgeEl.hidden = !provider || !provider.antecedentesVerified;
  }

  function loadProviders() {
    fetch("/api/providers")
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        var providers = data.providers || [];
        providerSelectEl.innerHTML = "";
        providersById = {};

        if (!providers.length) {
          var option = document.createElement("option");
          option.textContent = "Nenhum prestador disponível no momento";
          providerSelectEl.appendChild(option);
          return;
        }

        providers.forEach(function (provider) {
          providersById[provider.id] = provider;

          var option = document.createElement("option");
          option.value = provider.id;
          option.textContent =
            (provider.antecedentesVerified ? "✅ " : "") +
            provider.name +
            (provider.specialty ? " - " + provider.specialty : "") +
            (provider.isAvailable ? "" : " (indisponível no momento)");
          providerSelectEl.appendChild(option);
        });

        if (preselectedProviderId) {
          providerSelectEl.value = preselectedProviderId;
        }

        updateVerifiedBadge();
      })
      .catch(function () {
        feedbackEl.textContent = "Não foi possível carregar os prestadores.";
      });
  }

  providerSelectEl.addEventListener("change", updateVerifiedBadge);

  formEl.addEventListener("submit", async function (event) {
    var response;
    var result;

    event.preventDefault();

    var payload = {
      providerId: providerSelectEl.value,
      customerName: nameEl.value.trim(),
      customerPhone: phoneEl.value.trim(),
      locationLabel: locationEl.value.trim(),
      message: messageEl.value.trim()
    };

    if (!payload.providerId || !payload.customerName || !payload.customerPhone || !payload.message) {
      feedbackEl.textContent = "Preencha todos os campos pra enviar a solicitação.";
      return;
    }

    try {
      response = await fetch("/api/budget-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      result = await response.json();
    } catch (error) {
      feedbackEl.textContent = "Não foi possível enviar. Tente novamente.";
      return;
    }

    if (!response.ok) {
      feedbackEl.textContent = (result && result.error) || "Não foi possível enviar a solicitação.";
      return;
    }

    feedbackEl.textContent = "Solicitação enviada! Te levando pra conversa com o prestador...";
    window.location.href = "./conversa-prestador.html?id=" + encodeURIComponent(result.id);
  });

  loadProviders();
})();
