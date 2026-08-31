/**
 * api/admin/criar-usuario.js
 * ---------------------------------------------------------------------------
 * Da acesso ao Matricula.IA Interno para uma pessoa, identificada por e-mail.
 * Dois casos, tratados automaticamente:
 *  (a) E-mail novo (a pessoa ainda nao tem conta nem no ERP): cria a conta
 *      de autenticacao do zero, com a senha informada.
 *  (b) E-mail ja existe (ex: funcionario que ja usa o ERP): NAO cria conta
 *      duplicada - so adiciona esse usuario existente na lista de acesso
 *      deste sistema (a senha do ERP continua sendo a mesma, sem alteracao).
 * ---------------------------------------------------------------------------
 */
const { getSupabaseAdmin, getAuthenticatedUser } = require("../../server/supabaseAdmin");
const { checarRateLimit } = require("../../server/rateLimit");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ sucesso: false, erro: "Metodo nao permitido." });
  }

  try {
    const limite = await checarRateLimit(req, "admin-criar-usuario", 20, 15 * 60 * 1000);
    if (!limite.permitido) {
      return res.status(429).json({ sucesso: false, erro: "Muitas tentativas. Aguarde alguns minutos." });
    }

    const usuario = await getAuthenticatedUser(req);
    const admin = getSupabaseAdmin();

    const { data: chamador } = await admin.from("matriculaia_usuarios").select("papel").eq("user_id", usuario.id).maybeSingle();
    if (!chamador || chamador.papel !== "admin") {
      return res.status(403).json({ sucesso: false, erro: "Somente administradores podem adicionar usuarios." });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const userIdDireto = body && body.userId;
    const email = (body && body.email || "").trim().toLowerCase();
    const senha = body && body.senha;
    const nome = (body && body.nome || "").trim();
    const papel = body && body.papel === "admin" ? "admin" : "usuario";

    var userId = null;

    if (userIdDireto) {
      // Caminho rapido: clicou em "Dar acesso" direto na lista de funcionarios do ERP
      userId = userIdDireto;
    } else {
      if (!email) {
        return res.status(400).json({ sucesso: false, erro: "E-mail e obrigatorio." });
      }

      // Tenta criar uma conta nova primeiro
      if (senha) {
        const { data: criado, error: erroCriar } = await admin.auth.admin.createUser({
          email: email,
          password: senha,
          email_confirm: true
        });
        if (criado && criado.user) {
          userId = criado.user.id;
        } else if (erroCriar && !/already.*registered|already.*exists/i.test(erroCriar.message || "")) {
          throw erroCriar;
        }
      }

      // Se nao criou (porque ja existia, ou porque nenhuma senha foi informada
      // de proposito para reaproveitar conta existente), procura pelo e-mail
      if (!userId) {
        const { data: lista, error: erroLista } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (erroLista) throw erroLista;
        const encontrado = (lista.users || []).find(function (u) { return (u.email || "").toLowerCase() === email; });
        if (!encontrado) {
          return res.status(404).json({
            sucesso: false,
            erro: "Nenhuma conta encontrada com este e-mail (nem no ERP). Informe uma senha para criar uma conta nova."
          });
        }
        userId = encontrado.id;
      }
    }

    const { error: erroUpsert } = await admin.from("matriculaia_usuarios").upsert({
      user_id: userId,
      nome: nome || null,
      papel: papel,
      ativo: true
    });
    if (erroUpsert) throw erroUpsert;

    return res.status(200).json({ sucesso: true });
  } catch (err) {
    console.error("[criar-usuario] erro:", err);
    return res.status(err.statusCode || 500).json({ sucesso: false, erro: err.message || "Erro interno." });
  }
};
