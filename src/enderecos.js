(function enderecosPage() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  var listEl = document.getElementById("address-list");
  var addButtonEl = document.getElementById("add-address-button");
  var messageEl = document.getElementById("address-message");
  var escapeHtml = window.appDatabase.escapeHtml;

  var state = {
    formOpen: null, // null | "new" | <addressId>
  };

  function renderForm(address) {
    var isNew = !address;

    return (
      '<div class="address-card add-address-card">' +
      "<strong>" +
      (isNew ? "Novo endereço" : "Editar endereço") +
      "</strong>" +
      '<div class="compact-address-grid">' +
      '<input class="address-input" id="edit-address-street" type="text" placeholder="Rua" value="' +
      (isNew ? "" : escapeHtml(address.street || "")) +
      '" />' +
      '<input class="address-input" id="edit-address-number" type="text" placeholder="Número" value="' +
      (isNew ? "" : escapeHtml(address.number || "")) +
      '" />' +
      '<input class="address-input" id="edit-address-district" type="text" placeholder="Bairro" value="' +
      (isNew ? "" : escapeHtml(address.district || "")) +
      '" />' +
      '<input class="address-input" id="edit-address-reference" type="text" placeholder="Complemento ou referência" value="' +
      (isNew ? "" : escapeHtml(address.reference || "")) +
      '" />' +
      "</div>" +
      '<div class="checkout-actions compact-actions">' +
      '<button class="secondary-button" type="button" id="cancel-edit-address-button">Cancelar</button>' +
      '<button class="primary-button" type="button" id="save-edit-address-button">Salvar</button>' +
      "</div>" +
      "</div>"
    );
  }

  function renderCard(address, profile) {
    if (state.formOpen === address.id) {
      return renderForm(address);
    }

    var isDefault = address.id === profile.defaultAddressId;
    var label = window.appDatabase.formatAddress(address) || "Preencha o endereço";

    return (
      '<div class="address-card" data-address-id="' +
      address.id +
      '">' +
      '<div class="address-card-top">' +
      "<strong>" +
      escapeHtml(label) +
      "</strong>" +
      '<label class="item-toggle">' +
      '<input type="radio" name="default-address" value="' +
      address.id +
      '" data-action="set-default" ' +
      (isDefault ? "checked" : "") +
      " />" +
      "<span>" +
      (isDefault ? "Em uso" : "Usar este") +
      "</span>" +
      "</label>" +
      "</div>" +
      '<div class="checkout-actions compact-actions">' +
      '<button class="secondary-button small-button" type="button" data-action="edit" data-id="' +
      address.id +
      '">Editar</button>' +
      (profile.addresses.length > 1
        ? '<button class="secondary-button small-button" type="button" data-action="delete" data-id="' +
          address.id +
          '">Excluir</button>'
        : "") +
      "</div>" +
      "</div>"
    );
  }

  function render() {
    var profile = window.appDatabase.getProfile();
    var addresses = profile.addresses || [];

    listEl.innerHTML =
      addresses
        .map(function (address) {
          return renderCard(address, profile);
        })
        .join("") + (state.formOpen === "new" ? renderForm(null) : "");
  }

  function readFormValues() {
    return {
      street: document.getElementById("edit-address-street").value.trim(),
      number: document.getElementById("edit-address-number").value.trim(),
      district: document.getElementById("edit-address-district").value.trim(),
      reference: document.getElementById("edit-address-reference").value.trim(),
    };
  }

  function saveForm() {
    var values = readFormValues();

    if (!values.street) {
      messageEl.textContent = "Preencha ao menos a rua.";
      return;
    }

    var profile = window.appDatabase.getProfile();
    var addresses = profile.addresses || [];

    if (state.formOpen === "new") {
      var newAddress = Object.assign({ id: "address-" + Date.now() }, values);
      addresses.push(newAddress);
      profile.addresses = addresses;
      profile.defaultAddressId = newAddress.id;
      messageEl.textContent = "Endereço cadastrado e definido para entrega.";
    } else {
      var index = addresses.findIndex(function (item) {
        return item.id === state.formOpen;
      });

      if (index >= 0) {
        addresses[index] = Object.assign({}, addresses[index], values);
      }

      profile.addresses = addresses;
      messageEl.textContent = "Endereço atualizado.";
    }

    window.appDatabase.saveProfile(profile);
    state.formOpen = null;
    render();
  }

  addButtonEl.addEventListener("click", function () {
    state.formOpen = "new";
    messageEl.textContent = "";
    render();
  });

  listEl.addEventListener("click", function (event) {
    var target = event.target.closest("[data-action], #cancel-edit-address-button, #save-edit-address-button");
    if (!target) {
      return;
    }

    if (target.id === "cancel-edit-address-button") {
      state.formOpen = null;
      render();
      return;
    }

    if (target.id === "save-edit-address-button") {
      saveForm();
      return;
    }

    var action = target.dataset.action;

    if (action === "edit") {
      state.formOpen = target.dataset.id;
      messageEl.textContent = "";
      render();
      return;
    }

    if (action === "delete") {
      if (!window.confirm("Excluir este endereço?")) {
        return;
      }

      var profile = window.appDatabase.getProfile();
      var addresses = (profile.addresses || []).filter(function (item) {
        return item.id !== target.dataset.id;
      });

      profile.addresses = addresses;
      if (profile.defaultAddressId === target.dataset.id) {
        profile.defaultAddressId = addresses.length ? addresses[0].id : null;
      }

      window.appDatabase.saveProfile(profile);
      messageEl.textContent = "Endereco excluído.";
      render();
    }
  });

  listEl.addEventListener("change", function (event) {
    var target = event.target;
    if (target.dataset && target.dataset.action === "set-default") {
      var profile = window.appDatabase.getProfile();
      profile.defaultAddressId = target.value;
      window.appDatabase.saveProfile(profile);
      messageEl.textContent = "Endereço definido para entrega.";
      render();
    }
  });

  render();
})();
