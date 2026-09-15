(function forgotPasswordPage() {
  var formEl = document.getElementById("forgot-password-form");
  var emailEl = document.getElementById("forgot-email");
  var messageEl = document.getElementById("forgot-password-message");
  var backLinkEl = document.getElementById("forgot-password-back-link");

  if (!formEl) {
    return;
  }

  var params = new URLSearchParams(window.location.search);
  var type = params.get("type") || "customer";

  // Mesmo fluxo (link por e-mail) pra qualquer tipo de conta - só muda o
  // endpoint chamado e pra qual tela de login volta depois.
  var TYPE_CONFIG = {
    customer: { endpoint: "/api/auth/forgot-password", backUrl: "./index.html" },
    owner: { endpoint: "/api/auth/owner-forgot-password", backUrl: "./index.html?role=estabelecimento" },
    taxi: { endpoint: "/api/auth/taxi-forgot-password", backUrl: "./taxi.html" },
    provider: { endpoint: "/api/auth/provider-forgot-password", backUrl: "./provider.html" }
  };
  var config = TYPE_CONFIG[type] || TYPE_CONFIG.customer;

  if (backLinkEl) {
    backLinkEl.href = config.backUrl;
  }

  formEl.addEventListener("submit", async function (event) {
    event.preventDefault();

    try {
      var response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: emailEl.value.trim()
        })
      });
      var result = await response.json();

      messageEl.textContent =
        result && result.message
          ? result.message
          : "Se o e-mail existir, enviaremos um link para redefinir a senha.";
    } catch (error) {
      messageEl.textContent = "Não foi possível enviar o link agora.";
    }
  });
})();
