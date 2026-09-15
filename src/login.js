(function loginPage() {
  var formEl = document.getElementById("login-form");
  var usernameEl = document.getElementById("login-username");
  var passwordEl = document.getElementById("login-password");
  var messageEl = document.getElementById("login-message");
  var submitEl = document.getElementById("login-submit-button");
  var userLabelEl = document.getElementById("login-user-label");
  var cardTitleEl = document.getElementById("login-card-title");
  var roleButtons = document.querySelectorAll("[data-login-role]");
  var helpLinksEl = document.getElementById("login-help-links");
  var openRegisterButtonEl = document.getElementById("open-register-button");
  var openRecoveryButtonEl = document.getElementById("open-recovery-button");
  var switchToOwnerButtonEl = document.getElementById("switch-to-owner-button");
  var switchToCustomerButtonEl = document.getElementById("switch-to-customer-button");
  var registerFormEl = document.getElementById("register-form");
  var closeRegisterButtonEl = document.getElementById("close-register-button");
  var registerNameEl = document.getElementById("register-name");
  var registerCpfEl = document.getElementById("register-cpf");
  var registerPhoneEl = document.getElementById("register-phone");
  var registerStreetEl = document.getElementById("register-street");
  var registerNumberEl = document.getElementById("register-number");
  var registerDistrictEl = document.getElementById("register-district");
  var registerCityEl = document.getElementById("register-city");
  var registerZipEl = document.getElementById("register-zip");
  var registerComplementEl = document.getElementById("register-complement");
  var registerEmailEl = document.getElementById("register-email");
  var registerPasswordEl = document.getElementById("register-password");
  var registerPasswordConfirmEl = document.getElementById("register-password-confirm");
  var googleDividerEl = document.getElementById("google-signin-divider");
  var googleContainerEl = document.getElementById("google-signin-container");
  var params = new URLSearchParams(window.location.search);

  var state = {
    role: params.get("role") === "estabelecimento" ? "estabelecimento" : "cliente",
    isRegisterOpen: false,
    googleReady: false,
    pendingGoogleSub: "",
  };

  function syncRoleUi() {
    var showGoogle = state.googleReady && state.role === "cliente" && !state.isRegisterOpen;

    helpLinksEl.hidden = state.isRegisterOpen;
    formEl.hidden = state.isRegisterOpen;
    registerFormEl.hidden = state.role !== "cliente" || !state.isRegisterOpen;
    helpLinksEl.style.display = state.isRegisterOpen ? "none" : "";
    formEl.style.display = state.isRegisterOpen ? "none" : "";
    registerFormEl.style.display =
      state.role !== "cliente" || !state.isRegisterOpen ? "none" : "grid";
    cardTitleEl.textContent = state.isRegisterOpen ? "Criar conta" : "Entrar";
    openRegisterButtonEl.textContent =
      state.role === "estabelecimento" ? "Quero oferecer meus serviços" : "Criar uma conta";
    switchToOwnerButtonEl.hidden = state.role !== "cliente";
    switchToCustomerButtonEl.hidden = state.role !== "estabelecimento";

    googleDividerEl.hidden = !showGoogle;
    googleContainerEl.hidden = !showGoogle;
  }

  function waitForGoogleSdk(callback, attemptsLeft) {
    var remaining = attemptsLeft === undefined ? 20 : attemptsLeft;

    if (window.google && window.google.accounts && window.google.accounts.id) {
      callback();
      return;
    }

    if (remaining <= 0) {
      return;
    }

    setTimeout(function () {
      waitForGoogleSdk(callback, remaining - 1);
    }, 250);
  }

  async function handleGoogleCredentialResponse(response) {
    messageEl.textContent = "Entrando com Google...";

    try {
      var apiResponse = await fetch("/api/auth/google", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ credential: response.credential })
      });
      var result = await apiResponse.json();

      if (!apiResponse.ok) {
        messageEl.textContent =
          result && result.error ? result.error : "Não foi possível entrar com o Google.";
        return;
      }

      if (result.needsRegistration) {
        state.pendingGoogleSub = (result.prefill && result.prefill.googleSub) || "";
        registerNameEl.value = (result.prefill && result.prefill.name) || "";
        registerEmailEl.value = (result.prefill && result.prefill.email) || "";
        registerEmailEl.readOnly = true;
        setRole("cliente");
        state.isRegisterOpen = true;
        syncRoleUi();
        messageEl.textContent = "Falta pouco: complete seus dados para criar a conta.";
        return;
      }

      if (result.customer) {
        window.appDatabase.buildCustomerSessionFromServer(result.customer, result.token);
        window.location.href = "./home.html";
      }
    } catch (error) {
      messageEl.textContent = "Não foi possível entrar com o Google agora.";
    }
  }

  function initGoogleSignIn() {
    fetch("/api/config")
      .then(function (response) {
        return response.json();
      })
      .then(function (config) {
        if (!config || !config.googleClientId) {
          return;
        }

        waitForGoogleSdk(function () {
          window.google.accounts.id.initialize({
            client_id: config.googleClientId,
            callback: handleGoogleCredentialResponse
          });
          window.google.accounts.id.renderButton(googleContainerEl, {
            theme: "outline",
            size: "large",
            width: 320,
            text: "continue_with",
            locale: "pt-BR"
          });
          state.googleReady = true;
          syncRoleUi();
        });
      })
      .catch(function () {});
  }

  function setRole(role) {
    state.role = role;

    roleButtons.forEach(function (button) {
      button.classList.toggle("active", button.dataset.loginRole === role);
    });

    if (role === "cliente") {
      userLabelEl.textContent = "Entrar com e-mail ou CPF";
      usernameEl.placeholder = "";
    } else {
      userLabelEl.textContent = "Usuário";
      usernameEl.placeholder = "";
      state.isRegisterOpen = false;
    }

    submitEl.textContent = "Entrar";
    messageEl.textContent = "";
    syncRoleUi();
  }

  roleButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      setRole(button.dataset.loginRole);
    });
  });

  openRegisterButtonEl.addEventListener("click", function () {
    if (state.role === "estabelecimento") {
      window.location.href = "./partner-interest.html";
      return;
    }

    state.isRegisterOpen = true;
    state.pendingGoogleSub = "";
    registerEmailEl.readOnly = false;
    messageEl.textContent = "";
    syncRoleUi();
  });

  closeRegisterButtonEl.addEventListener("click", function () {
    state.isRegisterOpen = false;
    state.pendingGoogleSub = "";
    registerEmailEl.readOnly = false;
    messageEl.textContent = "";
    syncRoleUi();
  });

  openRecoveryButtonEl.addEventListener("click", function () {
    if (state.role === "estabelecimento") {
      window.location.href = "./forgot-password.html?type=owner";
      return;
    }

    window.location.href = "./forgot-password.html";
  });

  formEl.addEventListener("submit", async function (event) {
    var ownerSession;
    var username;
    var password;

    event.preventDefault();
    username = usernameEl.value.trim();
    password = passwordEl.value.trim();

    if (state.role === "cliente") {
      messageEl.textContent = "Entrando...";

      try {
        var response = await fetch("/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            identifier: username,
            password: password
          })
        });
        var backendResult = await response.json();

        if (!response.ok || !backendResult || !backendResult.customer) {
          messageEl.textContent =
            backendResult && backendResult.error ? backendResult.error : "E-mail/CPF ou senha inválidos.";
          return;
        }

        window.appDatabase.buildCustomerSessionFromServer(backendResult.customer, backendResult.token);
        window.location.href = "./home.html";
      } catch (error) {
        messageEl.textContent = "Não foi possível entrar agora. Verifique sua conexão com o servidor.";
      }

      return;
    }

    messageEl.textContent = "Entrando...";
    ownerSession = await window.appDatabase.loginOwnerOnServer(username, password);

    if (!ownerSession) {
      messageEl.textContent = "Usuário ou senha inválidos.";
      return;
    }

    window.location.href = "./admin.html";
  });

  registerFormEl.addEventListener("submit", async function (event) {
    var result;
    var payload;

    event.preventDefault();

    if (registerPasswordEl.value.trim().length < 8) {
      messageEl.textContent = "A senha deve ter pelo menos 8 caracteres.";
      return;
    }

    if (registerPasswordEl.value.trim() !== registerPasswordConfirmEl.value.trim()) {
      messageEl.textContent = "As senhas digitadas não coincidem.";
      return;
    }

    payload = {
      name: registerNameEl.value.trim(),
      cpf: registerCpfEl.value.trim(),
      phone: registerPhoneEl.value.trim(),
      email: registerEmailEl.value.trim(),
      password: registerPasswordEl.value.trim(),
      googleSub: state.pendingGoogleSub,
      address: {
        street: registerStreetEl.value.trim(),
        number: registerNumberEl.value.trim(),
        district: registerDistrictEl.value.trim(),
        // A cidade agora é escolhida numa lista fixa (só litoral do Paraná)
        // em vez de texto livre, pra evitar cadastro de cidade fora da área
        // que o app atende.
        city: registerCityEl.value,
        zipCode: registerZipEl.value.trim(),
        complement: registerComplementEl.value.trim(),
      },
    };

    try {
      var response = await fetch("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      result = await response.json();

      if (!response.ok) {
        messageEl.textContent =
          result && result.error ? result.error : "Não foi possível concluir o cadastro.";
        return;
      }

      if (result && result.customer) {
        window.appDatabase.syncCustomerFromServer(result.customer);
      }
    } catch (error) {
      messageEl.textContent = "Não foi possível concluir o cadastro agora. Verifique sua conexão com o servidor.";
      return;
    }

    if (!result || result.error) {
      messageEl.textContent =
        result && result.error ? result.error : "Não foi possível concluir o cadastro.";
      return;
    }

    state.isRegisterOpen = false;
    state.pendingGoogleSub = "";
    registerEmailEl.readOnly = false;
    usernameEl.value = registerEmailEl.value.trim();
    passwordEl.value = "";
    registerFormEl.reset();
    syncRoleUi();
    messageEl.textContent =
      "Cadastro confirmado. Agora entre com o e-mail e a senha que você criou.";
  });

  if (window.appDatabase.getOwnerSession()) {
    window.location.href = "./admin.html";
    return;
  }

  if (window.appDatabase.getCustomerSession()) {
    window.location.href = "./home.html";
    return;
  }

  setRole(state.role);
  initGoogleSignIn();
})();
