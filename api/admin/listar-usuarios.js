/**
 * api/admin/listar-usuarios.js
 * ---------------------------------------------------------------------------
 * Lista os usuarios com acesso ao Matricula.IA Interno. So administradores
 * podem chamar esta rota.
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

    const { data: linhas, error } = await admin
      .from("matriculaia_usuarios")
      .select("user_id, nome, papel, ativo, criado_em")
      .order("criado_em", { ascending: true });
    if (error) throw error;

    // Busca o e-mail de cada um via Admin API (nao fica na tabela propria, vem do auth.users)
    const usuarios = [];
    for (const linha of linhas) {
      const { data: authData } = await admin.auth.admin.getUserById(linha.user_id);
      usuarios.push({
        userId: linha.user_id,
        email: authData && authData.user ? authData.user.email : "(desconhecido)",
        nome: linha.nome,
        papel: linha.papel,
        ativo: linha.ativo,
        criadoEm: linha.criado_em
      });
    }

    return res.status(200).json({ sucesso: true, usuarios: usuarios });
  } catch (err) {
    console.error("[listar-usuarios] erro:", err);
    return res.status(err.statusCode || 500).json({ sucesso: false, erro: err.message || "Erro interno." });
  }
};
