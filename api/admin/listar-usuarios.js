/**
 * api/admin/listar-usuarios.js
 * ---------------------------------------------------------------------------
 * Lista TODOS os funcionarios que existem no ERP Integral (mesma base de
 * autenticacao), marcando quem ja tem acesso liberado ao Matricula.IA e
 * quem ainda nao tem - assim o admin pode liberar com um clique, sem
 * precisar digitar e-mail de cabeca.
 * ---------------------------------------------------------------------------
 */
const { getSupabaseAdmin, getAuthenticatedUser } = require("../../server/supabaseAdmin");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ sucesso: false, erro: "Metodo nao permitido." });
  }

  try {
    const usuario = await getAuthenticatedUser(req);
    const admin = getSupabaseAdmin();

    const { data: chamador } = await admin.from("matriculaia_usuarios").select("papel").eq("user_id", usuario.id).maybeSingle();
    if (!chamador || chamador.papel !== "admin") {
      return res.status(403).json({ sucesso: false, erro: "Somente administradores podem ver esta lista." });
    }

    // Todos os funcionarios do ERP (mesma base de auth.users)
    const { data: listaAuth, error: erroAuth } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (erroAuth) throw erroAuth;

    // Quem ja tem acesso liberado ao Matricula.IA, com nome/papel/status
    const { data: liberados, error: erroLiberados } = await admin
      .from("matriculaia_usuarios")
      .select("user_id, nome, papel, ativo, criado_em");
    if (erroLiberados) throw erroLiberados;

    const liberadosPorId = {};
    (liberados || []).forEach(function (l) { liberadosPorId[l.user_id] = l; });

    const usuarios = (listaAuth.users || [])
      .map(function (u) {
        const liberado = liberadosPorId[u.id];
        return {
          userId: u.id,
          email: u.email,
          nome: liberado ? liberado.nome : null,
          temAcesso: !!liberado,
          papel: liberado ? liberado.papel : null,
          ativo: liberado ? liberado.ativo : false,
          criadoEm: liberado ? liberado.criado_em : u.created_at
        };
      })
      .sort(function (a, b) {
        // quem ja tem acesso aparece primeiro, depois por e-mail
        if (a.temAcesso !== b.temAcesso) return a.temAcesso ? -1 : 1;
        return (a.email || "").localeCompare(b.email || "");
      });

    return res.status(200).json({ sucesso: true, usuarios: usuarios });
  } catch (err) {
    console.error("[listar-usuarios] erro:", err);
    return res.status(err.statusCode || 500).json({ sucesso: false, erro: err.message || "Erro interno." });
  }
};
