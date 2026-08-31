/**
 * lib/supabaseClient.js
 * ---------------------------------------------------------------------------
 * Este sistema (uso interno da Integral) compartilha a MESMA base de
 * autenticacao do ERP Integral - os funcionarios usam a mesma conta nos
 * dois sistemas. O acesso especifico a este app, porem, e controlado a
 * parte (tabela matriculaia_usuarios) - ter conta no ERP nao da acesso
 * automatico aqui.
 * ---------------------------------------------------------------------------
 */
(function (root) {
  "use strict";

  var SUPABASE_URL = "https://ycdsyilyvaxslkwbkxyo.supabase.co";
  var SUPABASE_PUBLISHABLE_KEY = "sb_publishable_A7fw5Et4_bfUnqohpGajCw_nfhT-3a4";

  if (typeof supabase === "undefined") {
    console.error("[supabaseClient] Biblioteca do Supabase nao carregou (verifique o <script> no index.html).");
    return;
  }

  root.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
})(window);
