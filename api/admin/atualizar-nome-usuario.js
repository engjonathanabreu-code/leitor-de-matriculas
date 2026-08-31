/**
 * api/admin/atualizar-nome-usuario.js
 * ---------------------------------------------------------------------------
 * Atualiza o nome de exibicao de alguem que ja tem acesso ao Matricula.IA
 * (o e-mail continua vindo do ERP, mas o nome mostrado no app pode ser
 * ajustado aqui, para nao ficar so o e-mail).
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
      return res.status(403).json({ sucesso: false, erro: "Somente administradores podem editar nomes." });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const userIdAlvo = body && body.userId;
    const nome = (body && body.nome || "").trim();
    if (!userIdAlvo || !nome) {
      return res.status(400).json({ sucesso: false, erro: "userId e nome sao obrigatorios." });
    }

    const { error } = await admin.from("matriculaia_usuarios").update({ nome: nome }).eq("user_id", userIdAlvo);
    if (error) throw error;

    // Atualiza tambem o nome ja gravado nos projetos existentes dessa pessoa,
    // para o nome novo aparecer certinho na lista "Todos os projetos" do admin.
    await admin.from("matriculaia_projetos").update({ dono_nome: nome }).eq("user_id", userIdAlvo);

    return res.status(200).json({ sucesso: true });
  } catch (err) {
    console.error("[atualizar-nome-usuario] erro:", err);
    return res.status(err.statusCode || 500).json({ sucesso: false, erro: err.message || "Erro interno." });
  }
};
