// Página de pedidos dedicada foi incorporada ao painel principal do lojista
// (admin.html), que agora tem menu lateral com a seção "Pedidos". Esse
// arquivo só existe pra não quebrar links/atalhos antigos (PWA instalado,
// favoritos etc.) que ainda apontam pra admin-pedidos.html.
(function adminPedidosRedirect() {
  window.location.replace("./admin.html");
})();
