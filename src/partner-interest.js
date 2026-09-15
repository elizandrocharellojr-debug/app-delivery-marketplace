(function partnerInterestPage() {
  var typeCardEl = document.getElementById("partner-type-card");
  var typeOptionEls = Array.prototype.slice.call(document.querySelectorAll(".partner-type-option"));
  var formCardEl = document.getElementById("partner-form-card");
  var formTitleEl = document.getElementById("partner-form-title");
  var formBackButtonEl = document.getElementById("partner-form-back-button");
  var formMessageEl = document.getElementById("partner-form-message");
  var successCardEl = document.getElementById("partner-success-card");
  var successTextEl = document.getElementById("partner-success-text");
  var successLinkEl = document.getElementById("partner-success-link");

  var storeFormEl = document.getElementById("partner-store-form");
  var taxiFormEl = document.getElementById("partner-taxi-form");
  var providerFormEl = document.getElementById("partner-provider-form");

  var storeCategorySelectEl = document.getElementById("store-signup-category");

  var FORM_TITLES = {
    estabelecimento: "Cadastro de estabelecimento",
    motorista: "Cadastro de motorista",
    prestador: "Cadastro de prestador de serviço"
  };

  var FORMS_BY_TYPE = {
    estabelecimento: storeFormEl,
    motorista: taxiFormEl,
    prestador: providerFormEl
  };

  function clearMessage() {
    formMessageEl.textContent = "";
    formMessageEl.dataset.state = "";
  }

  function showError(message) {
    formMessageEl.textContent = message;
    formMessageEl.dataset.state = "error";
  }

  function loadCategoriesIntoSelect() {
    if (!storeCategorySelectEl || storeCategorySelectEl.dataset.loaded === "true") {
      return;
    }

    fetch("/api/catalog")
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        var categories = (data && data.categories) || [];
        // "Serviços" fica de fora daqui - é a categoria dos prestadores de
        // serviço (que têm o próprio fluxo de cadastro), não faz sentido
        // pra quem está cadastrando um estabelecimento.
        categories = categories.filter(function (category) {
          return category.id !== "servicos";
        });
        storeCategorySelectEl.innerHTML = categories
          .map(function (category) {
            return '<option value="' + category.id + '">' + category.name + "</option>";
          })
          .join("");
        storeCategorySelectEl.dataset.loaded = "true";
      })
      .catch(function () {
        storeCategorySelectEl.innerHTML = '<option value="comida">Comida</option>';
      });
  }

  function showTypeStep() {
    typeCardEl.hidden = false;
    formCardEl.hidden = true;
    successCardEl.hidden = true;
    clearMessage();
  }

  function showFormStep(type) {
    typeCardEl.hidden = true;
    formCardEl.hidden = false;
    successCardEl.hidden = true;
    clearMessage();

    formTitleEl.textContent = FORM_TITLES[type] || "Cadastro";

    Object.keys(FORMS_BY_TYPE).forEach(function (key) {
      FORMS_BY_TYPE[key].hidden = key !== type;
    });

    if (type === "estabelecimento") {
      loadCategoriesIntoSelect();
    }
  }

  function showSuccessStep(message, linkHref, linkLabel) {
    typeCardEl.hidden = true;
    formCardEl.hidden = true;
    successCardEl.hidden = false;
    successTextEl.textContent = message;
    successLinkEl.setAttribute("href", linkHref);
    successLinkEl.textContent = linkLabel;
  }

  typeOptionEls.forEach(function (button) {
    button.addEventListener("click", function () {
      showFormStep(button.dataset.type);
    });
  });

  formBackButtonEl.addEventListener("click", function () {
    showTypeStep();
  });

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().then(function (result) {
        return { ok: response.ok, status: response.status, body: result };
      });
    });
  }

  function formatFileSize(bytes) {
    if (bytes > 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ""));
      };
      reader.onerror = function () {
        reject(new Error("Não foi possível ler o arquivo."));
      };
      reader.readAsDataURL(file);
    });
  }

  // Liga um <input type="file"> a um pedacinho de texto de status e guarda
  // o conteúdo em base64 dentro de "state[key]" assim que a pessoa escolhe
  // o arquivo - tudo isso vai junto no mesmo POST do cadastro depois.
  function bindFileField(inputId, statusId, state, key) {
    var inputEl = document.getElementById(inputId);
    var statusEl = document.getElementById(statusId);

    if (!inputEl || !statusEl) {
      return;
    }

    inputEl.addEventListener("change", function () {
      var file = inputEl.files && inputEl.files[0];

      if (!file) {
        state[key] = "";
        statusEl.textContent = "Nenhum arquivo selecionado.";
        return;
      }

      statusEl.textContent = "Lendo arquivo...";
      readFileAsDataUrl(file)
        .then(function (dataUrl) {
          state[key] = dataUrl;
          statusEl.textContent = file.name + " (" + formatFileSize(file.size) + ")";
        })
        .catch(function () {
          state[key] = "";
          statusEl.textContent = "Não foi possível ler esse arquivo. Tente outro.";
        });
    });
  }

  storeFormEl.addEventListener("submit", async function (event) {
    event.preventDefault();
    clearMessage();

    var storeName = document.getElementById("store-signup-name").value.trim();
    var categoryId = storeCategorySelectEl.value;
    var ownerName = document.getElementById("store-signup-owner-name").value.trim();
    var cpf = document.getElementById("store-signup-cpf").value.trim();
    var cnpj = document.getElementById("store-signup-cnpj").value.trim();
    var phone = document.getElementById("store-signup-phone").value.trim();
    var email = document.getElementById("store-signup-email").value.trim();
    var description = document.getElementById("store-signup-description").value.trim();
    var zipCode = document.getElementById("store-signup-zip").value.trim();
    var street = document.getElementById("store-signup-street").value.trim();
    var number = document.getElementById("store-signup-number").value.trim();
    var district = document.getElementById("store-signup-district").value.trim();
    var city = document.getElementById("store-signup-city").value.trim();
    var password = document.getElementById("store-signup-password").value;
    var passwordConfirm = document.getElementById("store-signup-password-confirm").value;

    if (
      !storeName ||
      !categoryId ||
      !ownerName ||
      !cpf ||
      !phone ||
      !email ||
      !password ||
      !street ||
      !number ||
      !district ||
      !city
    ) {
      showError("Preencha todos os campos obrigatórios, incluindo o endereço da loja.");
      return;
    }

    if (password !== passwordConfirm) {
      showError("As senhas não são iguais.");
      return;
    }

    formMessageEl.textContent = "Cadastrando...";
    formMessageEl.dataset.state = "";

    var result;
    try {
      result = await postJson("/api/signup/store", {
        storeName: storeName,
        categoryId: categoryId,
        ownerName: ownerName,
        cpf: cpf,
        cnpj: cnpj,
        phone: phone,
        email: email,
        description: description,
        password: password,
        address: {
          zipCode: zipCode,
          street: street,
          number: number,
          district: district,
          city: city
        }
      });
    } catch (error) {
      showError("Não foi possível falar com o servidor agora.");
      return;
    }

    if (!result.ok) {
      showError((result.body && result.body.error) || "Não foi possível concluir o cadastro.");
      return;
    }

    var owner = result.body.owner;
    var session = {
      ownerId: owner.id,
      ownerName: owner.ownerName,
      storeId: owner.storeId,
      storeName: owner.storeName,
      username: owner.username,
      email: owner.email || "",
      token: result.body.token
    };
    window.appDatabase.saveOwnerSession(session);
    window.location.href = "./admin.html";
  });

  var taxiDocsState = {};
  bindFileField("taxi-signup-cnh-front-input", "taxi-signup-cnh-front-status", taxiDocsState, "cnhFrontPhoto");
  bindFileField("taxi-signup-cnh-back-input", "taxi-signup-cnh-back-status", taxiDocsState, "cnhBackPhoto");
  bindFileField("taxi-signup-cnh-digital-input", "taxi-signup-cnh-digital-status", taxiDocsState, "cnhDigitalPdf");
  bindFileField("taxi-signup-crlv-input", "taxi-signup-crlv-status", taxiDocsState, "crlvPhoto");
  bindFileField(
    "taxi-signup-criminal-record-input",
    "taxi-signup-criminal-record-status",
    taxiDocsState,
    "criminalRecordPhoto"
  );

  // Alterna entre "tenho o cartão físico" (pede frente + verso) e "só tenho
  // a CNH digital" (pede um único PDF exportado do app Vio) - só um dos dois
  // grupos de campo fica visível e é validado/enviado por vez.
  var cnhTypeRadios = document.querySelectorAll('input[name="taxi-signup-cnh-type"]');
  var cnhPhysicalFieldsEl = document.getElementById("taxi-signup-cnh-physical-fields");
  var cnhDigitalFieldsEl = document.getElementById("taxi-signup-cnh-digital-fields");

  function getSelectedCnhType() {
    var checked = document.querySelector('input[name="taxi-signup-cnh-type"]:checked');
    return checked ? checked.value : "fisica";
  }

  function updateCnhTypeVisibility() {
    var isDigital = getSelectedCnhType() === "digital";
    cnhPhysicalFieldsEl.hidden = isDigital;
    cnhDigitalFieldsEl.hidden = !isDigital;
  }

  cnhTypeRadios.forEach(function (radio) {
    radio.addEventListener("change", updateCnhTypeVisibility);
  });
  updateCnhTypeVisibility();

  taxiFormEl.addEventListener("submit", async function (event) {
    event.preventDefault();
    clearMessage();

    var name = document.getElementById("taxi-signup-name").value.trim();
    var cpf = document.getElementById("taxi-signup-cpf").value.trim();
    var phone = document.getElementById("taxi-signup-phone").value.trim();
    var email = document.getElementById("taxi-signup-email").value.trim();
    var vehicle = document.getElementById("taxi-signup-vehicle").value.trim();
    var plate = document.getElementById("taxi-signup-plate").value.trim();
    var cnhNumber = document.getElementById("taxi-signup-cnh-number").value.trim();
    var cnhCategory = document.getElementById("taxi-signup-cnh-category").value;
    var cnhExpiresAt = document.getElementById("taxi-signup-cnh-expires").value;
    var cnhHasEar = document.getElementById("taxi-signup-cnh-ear").checked;
    var password = document.getElementById("taxi-signup-password").value;
    var passwordConfirm = document.getElementById("taxi-signup-password-confirm").value;

    if (!name || !cpf || !phone || !email || !vehicle || !plate || !cnhNumber || !cnhCategory || !cnhExpiresAt || !password) {
      showError("Preencha todos os campos obrigatórios, incluindo o veículo, a placa e os dados da CNH.");
      return;
    }

    if (!cnhHasEar) {
      showError("Confirme que sua CNH tem a observação EAR - é obrigatório pra transportar passageiros.");
      return;
    }

    var cnhType = getSelectedCnhType();

    if (cnhType === "digital") {
      if (!taxiDocsState.cnhDigitalPdf) {
        showError("Anexe o PDF da sua CNH digital exportado do app Vio (veja o passo a passo acima).");
        return;
      }
    } else if (!taxiDocsState.cnhFrontPhoto || !taxiDocsState.cnhBackPhoto) {
      showError("Envie a foto da frente e do verso da CNH (ou marque a opção de CNH digital, se só tiver ela).");
      return;
    }

    if (!taxiDocsState.crlvPhoto || !taxiDocsState.criminalRecordPhoto) {
      showError("Envie o CRLV do veículo e a certidão de antecedentes criminais.");
      return;
    }

    if (password !== passwordConfirm) {
      showError("As senhas não são iguais.");
      return;
    }

    formMessageEl.textContent = "Cadastrando...";
    formMessageEl.dataset.state = "";

    var result;
    try {
      result = await postJson("/api/signup/taxi-driver", {
        name: name,
        cpf: cpf,
        phone: phone,
        email: email,
        vehicle: vehicle + " - " + plate,
        cnhNumber: cnhNumber,
        cnhCategory: cnhCategory,
        cnhExpiresAt: cnhExpiresAt,
        cnhHasEar: cnhHasEar,
        cnhType: cnhType,
        cnhFrontPhoto: taxiDocsState.cnhFrontPhoto,
        cnhBackPhoto: taxiDocsState.cnhBackPhoto,
        cnhDigitalPdf: taxiDocsState.cnhDigitalPdf,
        crlvPhoto: taxiDocsState.crlvPhoto,
        criminalRecordPhoto: taxiDocsState.criminalRecordPhoto,
        password: password
      });
    } catch (error) {
      showError("Não foi possível falar com o servidor agora.");
      return;
    }

    if (!result.ok) {
      showError((result.body && result.body.error) || "Não foi possível concluir o cadastro.");
      return;
    }

    showSuccessStep(
      "Sua conta de motorista foi criada. Usuário: " +
        result.body.username +
        ". Você já pode entrar no painel do motorista, mas só consegue ficar online depois que a gente conferir " +
        "os documentos enviados.",
      "./taxi.html",
      "Entrar no painel do motorista"
    );
  });

  var providerDocsState = {};
  bindFileField(
    "provider-signup-criminal-record-input",
    "provider-signup-criminal-record-status",
    providerDocsState,
    "criminalRecordPhoto"
  );

  providerFormEl.addEventListener("submit", async function (event) {
    event.preventDefault();
    clearMessage();

    var name = document.getElementById("provider-signup-name").value.trim();
    var cpf = document.getElementById("provider-signup-cpf").value.trim();
    var phone = document.getElementById("provider-signup-phone").value.trim();
    var email = document.getElementById("provider-signup-email").value.trim();
    var specialty = document.getElementById("provider-signup-specialty").value.trim();
    var password = document.getElementById("provider-signup-password").value;
    var passwordConfirm = document.getElementById("provider-signup-password-confirm").value;

    if (!name || !cpf || !phone || !email || !specialty || !password) {
      showError("Preencha todos os campos obrigatórios.");
      return;
    }

    if (password !== passwordConfirm) {
      showError("As senhas não são iguais.");
      return;
    }

    formMessageEl.textContent = "Cadastrando...";
    formMessageEl.dataset.state = "";

    var result;
    try {
      result = await postJson("/api/signup/provider", {
        name: name,
        cpf: cpf,
        phone: phone,
        email: email,
        specialty: specialty,
        password: password,
        criminalRecordPhoto: providerDocsState.criminalRecordPhoto || ""
      });
    } catch (error) {
      showError("Não foi possível falar com o servidor agora.");
      return;
    }

    if (!result.ok) {
      showError((result.body && result.body.error) || "Não foi possível concluir o cadastro.");
      return;
    }

    showSuccessStep(
      "Sua conta de prestador foi criada. Usuário: " +
        result.body.username +
        ". Agora é só entrar no painel do prestador com o usuário e a senha que você acabou de escolher.",
      "./provider.html",
      "Entrar no painel do prestador"
    );
  });

  var initialKind = new URLSearchParams(window.location.search).get("kind");
  if (initialKind === "servico") {
    showFormStep("prestador");
  } else {
    showTypeStep();
  }
})();
