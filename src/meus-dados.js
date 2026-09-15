(function meusDadosPage() {
  if (!window.appDatabase.getCustomerSession()) {
    if (window.appDatabase.getOwnerSession()) {
      window.location.href = "./admin.html";
      return;
    }

    window.location.href = "./index.html";
    return;
  }

  var formEl = document.getElementById("profile-form");
  var nameEl = document.getElementById("profile-name");
  var phoneEl = document.getElementById("profile-phone");
  var messageEl = document.getElementById("profile-message");

  function fillForm() {
    var profile = window.appDatabase.getProfile();
    nameEl.value = profile.name;
    phoneEl.value = profile.phone;
  }

  formEl.addEventListener("input", function () {
    var profile = window.appDatabase.getProfile();
    profile.name = nameEl.value.trim();
    profile.phone = phoneEl.value.trim();
    window.appDatabase.saveProfile(profile);
    messageEl.textContent = "Dados salvos automaticamente.";
  });

  fillForm();
})();
