/**
 * server/rateLimit.js
 * ---------------------------------------------------------------------------
 * Limite de requisicoes por IP, usando a tabela matriculaia_rate_limits
 * (prefixada para nunca colidir com tabelas do ERP no mesmo banco).
 * ---------------------------------------------------------------------------
 */
const { getSupabaseAdmin } = require("./supabaseAdmin");

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "desconhecido";
}

async function checarRateLimit(req, escopo, limite, janelaMs) {
  const ip = getClientIp(req);
  const chave = escopo + ":" + ip;
  const agora = Date.now();
  const admin = getSupabaseAdmin();

  const { data: existente } = await admin
    .from("matriculaia_rate_limits")
    .select("*")
    .eq("chave", chave)
    .maybeSingle();

  if (!existente) {
    await admin.from("matriculaia_rate_limits").insert({ chave: chave, janela_inicio: new Date(agora).toISOString(), contagem: 1 });
    return { permitido: true, restante: limite - 1 };
  }

  const inicioJanela = new Date(existente.janela_inicio).getTime();
  if (agora - inicioJanela > janelaMs) {
    await admin
      .from("matriculaia_rate_limits")
      .update({ janela_inicio: new Date(agora).toISOString(), contagem: 1 })
      .eq("chave", chave);
    return { permitido: true, restante: limite - 1 };
  }

  if (existente.contagem >= limite) {
    return { permitido: false, restante: 0 };
  }

  await admin.from("matriculaia_rate_limits").update({ contagem: existente.contagem + 1 }).eq("chave", chave);
  return { permitido: true, restante: limite - existente.contagem - 1 };
}

module.exports = { checarRateLimit, getClientIp };
