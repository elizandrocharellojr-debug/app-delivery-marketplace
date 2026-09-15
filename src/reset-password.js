(function resetPasswordPage() {
  var formEl = document.getElementById("reset-password-form");
  var passwordEl = document.getElementById("reset-password");
  var passwordConfirmEl = document.getElementById("reset-password-confirm");
  var messageEl = document.getElementById("reset-password-message");
  var backLinkEl = document.getElementById("reset-password-back-link");
  var params = new URLSearchParams(window.location.search);
  var token = params.get("token") || "";
  var email = "";
  var accountType = params.get("type") || "customer";

  // O link de e-mail já leva o tipo de conta na URL, mas o que vale mesmo é
  // o que o servidor devolve ao validar o token (accountType), já que é ele
  // quem sabe de qual tabela aquele token realmente é.
  var LOGIN_URLS = {
    customer: "./index.html",
    owner: "./index.html?role=estabelecimento",
    taxi: "./taxi.html",
    provider: "./provider.html"
  };

  var LOGIN_HINTS = {
    customer: "Agora entre com seu e-mail (ou CPF) e a nova senha.",
    owner: "Agora entre com seu usuário e a nova senha.",
    taxi: "Agora entre com seu usuário e a nova senha.",
    provider: "Agora entre com seu usuário e a nova senha."
  };

  function minPasswordLength() {
    return accountType === "taxi" ? 6 : 8;
  }

  function applyBackLink() {
    if (backLinkEl) {
      backLinkEl.href = LOGIN_URLS[accountType] || LOGIN_URLS.customer;
    }
  }

  async function validateToken() {
    if (!token) {
      messageEl.textContent = "Esse link de redefinição é inválido.";
      formEl.hidden = true;
      formEl.style.display = "none";
      return;
    }

    try {
      var response = await fetch(
        "/api/auth/validate-reset-token?token=" + encodeURIComponent(token)
      );
      var result = await response.json();

      if (!response.ok) {
        throw new Error(result && result.error ? result.error : "Token inválido.");
      }

      email = result.email || "";
      accountType = result.accountType || accountType;
      applyBackLink();
    } catch (error) {
      messageEl.textContent = error.message || "Esse link de redefinição expirou.";
      formEl.hidden = true;
      formEl.style.display = "none";
    }
  }

  if (!formEl) {
    return;
  }

  applyBackLink();

  formEl.addEventListener("submit", async function (event) {
    event.preventDefault();

    var minLength = minPasswordLength();
    if (passwordEl.value.trim().length < minLength) {
      messageEl.textContent = "A senha deve ter pelo menos " + minLength + " caracteres.";
      return;
    }

    if (passwordEl.value.trim() !== passwordConfirmEl.value.trim()) {
      messageEl.textContent = "As senhas digitadas não coincidem.";
      return;
    }

    try {
      var response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          token: token,
          password: passwordEl.value.trim()
        })
      });
      var result = await response.json();

      if (!response.ok) {
        throw new Error(result && result.error ? result.error : "Não foi possível salvar a nova senha.");
      }

      accountType = result.accountType || accountType;
      applyBackLink();

      messageEl.textContent =
        "Senha atualizada com sucesso. " + (LOGIN_HINTS[accountType] || LOGIN_HINTS.customer);
      formEl.reset();
    } catch (error) {
      messageEl.textContent = error.message || "Não foi possível salvar a nova senha.";
    }
  });

  validateToken();
})();
