(function backButtonHandler() {
  // ".back-btn" é o botão-ícone usado no cabeçalho da maioria das telas;
  // ".back-link" é a variante em texto ("Voltar") usada nas telas no
  // estilo de formulário (login, recuperar senha, solicitar orçamento,
  // etc.) - as duas usam a mesma lógica de "voltar de verdade" (histórico
  // do navegador) em vez de sempre cair numa página fixa.
  var backButtons = document.querySelectorAll(".back-btn, .back-link");

  backButtons.forEach(function (button) {
    button.addEventListener("click", function (event) {
      var fallback = button.getAttribute("href") || "./home.html";
      var forceHref = button.getAttribute("data-force-href") === "true";

      if (forceHref) {
        return;
      }

      if (window.history.length > 1) {
        event.preventDefault();
        window.history.back();
        return;
      }

      button.setAttribute("href", fallback);
    });
  });
})();
