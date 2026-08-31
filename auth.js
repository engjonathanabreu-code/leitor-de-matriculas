/**
 * auth.js (edicao interna - Integral)
 * ---------------------------------------------------------------------------
 * Sistema de uso interno: NAO existe cadastro publico. As contas usam a
 * mesma base de autenticacao do ERP Integral, mas o acesso a ESTE sistema
 * e controlado a parte (tabela matriculaia_usuarios) - so quem um
 * administrador liberou explicitamente consegue entrar.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  var state = {
    session: null,
    usuarioInterno: null // { papel: 'admin'|'usuario', nome, ativo }
  };

  function esc(str) {
    if (str == null) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function mostrarErroAuth(msg) {
    var el = document.getElementById("auth-error");
    el.textContent = msg;
    el.hidden = false;
  }
  function esconderErroAuth() {
    document.getElementById("auth-error").hidden = true;
  }

  function traduzErroAuth(msg) {
    if (/invalid login credentials/i.test(msg)) return "E-mail ou senha incorretos.";
    return msg;
  }

  function initAuthForm() {
    document.getElementById("form-auth").addEventListener("submit", async function (e) {
      e.preventDefault();
      esconderErroAuth();
      var email = document.getElementById("auth-email").value.trim();
      var senha = document.getElementById("auth-senha").value;
      var btn = document.getElementById("btn-auth-submit");
      btn.disabled = true;

      try {
        var resp = await window.supabaseClient.auth.signInWithPassword({ email: email, password: senha });
        if (resp.error) throw resp.error;
      } catch (err) {
        mostrarErroAuth(traduzErroAuth(err && err.message ? err.message : String(err)));
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("btn-auth-google").addEventListener("click", async function () {
      esconderErroAuth();
      var { error } = await window.supabaseClient.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin }
      });
      if (error) mostrarErroAuth(traduzErroAuth(error.message));
    });
  }

  function mostrarGateDeAuth() {
    var gate = document.getElementById("auth-gate");
    gate.hidden = false;
    gate.style.display = "flex";
    document.querySelector(".app-shell").style.display = "none";
  }

  function esconderGateDeAuth() {
    var gate = document.getElementById("auth-gate");
    gate.hidden = true;
    gate.style.display = "none";
    document.querySelector(".app-shell").style.display = "";
  }

  /** Confere se esta conta foi liberada para este sistema. Se nao, mostra o motivo e desloga. */
  async function checarAcessoInterno(userId) {
    var { data, error } = await window.supabaseClient
      .from("matriculaia_usuarios")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error || !data || !data.ativo) {
      mostrarErroAuth(
        "Sua conta ainda nao tem acesso a este sistema, ou foi desativada. Fale com um administrador da Integral."
      );
      await window.supabaseClient.auth.signOut();
      return null;
    }
    return data;
  }

  // ==========================================================================
  // PAINEL "USUARIOS" (somente admin)
  // ==========================================================================
  async function chamarApiComAuth(url, method, body) {
    var resp = await fetch(url, {
      method: method || "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + state.session.access_token
      },
      body: body ? JSON.stringify(body) : undefined
    });
    var json = await resp.json();
    if (!resp.ok || !json.sucesso) throw new Error(json.erro || "Erro ao comunicar com o servidor.");
    return json;
  }

  function iniciaisDoNome(nome, email) {
    var base = (nome || email || "?").trim();
    var partes = base.split(/\s+/);
    var iniciais = partes.length > 1 ? partes[0][0] + partes[partes.length - 1][0] : base.slice(0, 2);
    return iniciais.toUpperCase();
  }

  async function renderUsuarios() {
    var container = document.getElementById("usuarios-content");
    container.innerHTML = '<p class="empty-state-inline">Carregando funcionarios do ERP...</p>';
    try {
      var json = await chamarApiComAuth("/api/admin/listar-usuarios", "GET");
      var html = '<div class="usuarios-grid">';
      json.usuarios.forEach(function (u) {
        var semAcesso = !u.temAcesso;
        html +=
          '<div class="usuario-card' + (semAcesso ? " usuario-card--sem-acesso" : (!u.ativo ? " usuario-card--inativo" : "")) + '">' +
          '<div class="usuario-avatar">' + esc(iniciaisDoNome(u.nome, u.email)) + "</div>" +
          '<div class="usuario-info">' +
          '<div class="usuario-nome">' + esc(u.nome || u.email) + "</div>" +
          '<div class="usuario-email">' + esc(u.email) + "</div>" +
          (semAcesso
            ? '<span class="usuario-papel usuario-papel--sem-acesso">Sem acesso ao Matricula.IA</span>'
            : '<span class="usuario-papel usuario-papel--' + u.papel + '">' + (u.papel === "admin" ? "Administrador" : "Usuario") + "</span>") +
          "</div>" +
          (u.userId === state.session.user.id
            ? '<span class="usuario-voce">Voce</span>'
            : semAcesso
              ? '<button class="btn-icon-text usuario-dar-acesso" data-dar-acesso="' + u.userId + '" title="Liberar acesso">Dar acesso</button>'
              : '<button class="btn-icon-text usuario-remover" data-remover-usuario="' + u.userId + '" title="Remover acesso">Remover</button>') +
          "</div>";
      });
      html += "</div>";
      container.innerHTML = html;

      container.querySelectorAll("[data-dar-acesso]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          btn.disabled = true;
          btn.textContent = "Liberando...";
          try {
            await chamarApiComAuth("/api/admin/criar-usuario", "POST", { userId: btn.dataset.darAcesso, papel: "usuario" });
            renderUsuarios();
          } catch (err) {
            alert("Erro ao liberar acesso: " + err.message);
            btn.disabled = false;
            btn.textContent = "Dar acesso";
          }
        });
      });

      container.querySelectorAll("[data-remover-usuario]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          if (!confirm("Remover o acesso desta pessoa ao Matricula.IA? (a conta dela no ERP continua normal)")) return;
          try {
            await chamarApiComAuth("/api/admin/excluir-usuario", "POST", { userId: btn.dataset.removerUsuario });
            renderUsuarios();
          } catch (err) {
            alert("Erro ao remover: " + err.message);
          }
        });
      });
    } catch (err) {
      container.innerHTML = '<p class="empty-state-inline">Erro ao carregar usuarios: ' + esc(err.message) + "</p>";
    }
  }

  function initPainelUsuarios() {
    document.getElementById("btn-adicionar-usuario").addEventListener("click", function () {
      document.getElementById("form-adicionar-usuario").hidden = false;
    });
    document.getElementById("btn-cancelar-adicionar-usuario").addEventListener("click", function () {
      document.getElementById("form-adicionar-usuario").hidden = true;
    });
    document.getElementById("form-adicionar-usuario").addEventListener("submit", async function (e) {
      e.preventDefault();
      var email = document.getElementById("novo-usuario-email").value.trim();
      var nome = document.getElementById("novo-usuario-nome").value.trim();
      var senha = document.getElementById("novo-usuario-senha").value.trim();
      var papel = document.getElementById("novo-usuario-papel").value;
      var erroEl = document.getElementById("novo-usuario-erro");
      erroEl.hidden = true;

      try {
        await chamarApiComAuth("/api/admin/criar-usuario", "POST", {
          email: email, nome: nome, senha: senha || undefined, papel: papel
        });
        document.getElementById("form-adicionar-usuario").hidden = true;
        document.getElementById("form-adicionar-usuario").reset();
        renderUsuarios();
      } catch (err) {
        erroEl.textContent = err.message;
        erroEl.hidden = false;
      }
    });
  }

  // ==========================================================================
  // BOOT
  // ==========================================================================
  document.addEventListener("DOMContentLoaded", function () {
    initAuthForm();
    initPainelUsuarios();

    window.supabaseClient.auth.onAuthStateChange(async function (event, session) {
      if (session) {
        var registro = await checarAcessoInterno(session.user.id);
        if (!registro) return; // sem acesso - checarAcessoInterno ja deslogou e mostrou o motivo

        state.session = session;
        state.usuarioInterno = registro;
        esconderGateDeAuth();

        document.getElementById("nome-usuario-logado").textContent = registro.nome || session.user.email;
        var navUsuarios = document.getElementById("nav-usuarios");
        if (navUsuarios) navUsuarios.hidden = registro.papel !== "admin";

        if (typeof window.__iniciarAppPrincipal === "function") {
          window.__iniciarAppPrincipal(session);
        }
      } else {
        state.session = null;
        state.usuarioInterno = null;
        mostrarGateDeAuth();
      }
    });

    document.getElementById("btn-sair").addEventListener("click", async function () {
      if (!confirm("Sair da sua conta?")) return;
      await window.supabaseClient.auth.signOut();
    });
  });

  window.__auth = {
    getAccessToken: function () { return state.session ? state.session.access_token : null; },
    ehAdmin: function () { return !!(state.usuarioInterno && state.usuarioInterno.papel === "admin"); },
    getNomeUsuario: function () { return state.usuarioInterno ? state.usuarioInterno.nome : null; },
    getUserId: function () { return state.session ? state.session.user.id : null; },
    renderUsuarios: renderUsuarios
  };
})();
