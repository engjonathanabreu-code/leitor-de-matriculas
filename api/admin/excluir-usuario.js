/**
 * api/admin/excluir-usuario.js
 * ---------------------------------------------------------------------------
 * Revoga o acesso de alguem ao Matricula.IA Interno. IMPORTANTE: como a
 * conta de autenticacao e compartilhada com o ERP Integral, isto NUNCA
 * apaga a conta em si (a pessoa continua podendo usar o ERP normalmente) -
 * so remove a liberacao especifica deste sistema.
 * ---------------------------------------------------------------------------
 */
const { getSupabaseAdmin, getAuthenticatedUser } = require("../../server/supabaseAdmin");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ sucesso: false, erro: "Metodo nao permitido." });
  }

  try {
    const usuario = await getAuthenticatedUser(req);
    const admin = getSupabaseAdmin();

    const { data: chamador } = await admin.from("matriculaia_usuarios").select("papel").eq("user_id", usuario.id).maybeSingle();
    if (!chamador || chamador.papel !== "admin") {
      return res.status(403).json({ sucesso: false, erro: "Somente administradores podem remover usuarios." });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const userIdParaRemover = body && body.userId;
    if (!userIdParaRemover) {
      return res.status(400).json({ sucesso: false, erro: "userId e obrigatorio." });
    }

    if (userIdParaRemover === usuario.id) {
      return res.status(400).json({ sucesso: false, erro: "Voce nao pode remover o proprio acesso." });
    }

    // Nao deixa remover o ultimo administrador (travaria o sistema sem ninguem para gerenciar)
    const { data: alvo } = await admin.from("matriculaia_usuarios").select("papel").eq("user_id", userIdParaRemover).maybeSingle();
    if (alvo && alvo.papel === "admin") {
      const { count } = await admin
        .from("matriculaia_usuarios")
        .select("user_id", { count: "exact", head: true })
        .eq("papel", "admin")
        .eq("ativo", true);
      if ((count || 0) <= 1) {
        return res.status(400).json({ sucesso: false, erro: "Este e o unico administrador ativo - nao e possivel remove-lo." });
      }
    }

    const { error } = await admin.from("matriculaia_usuarios").delete().eq("user_id", userIdParaRemover);
    if (error) throw error;

    return res.status(200).json({ sucesso: true });
  } catch (err) {
    console.error("[excluir-usuario] erro:", err);
    return res.status(err.statusCode || 500).json({ sucesso: false, erro: err.message || "Erro interno." });
  }
};
