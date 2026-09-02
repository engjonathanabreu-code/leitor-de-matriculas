/**
 * api/analisar-ortofoto.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA - Vercel Serverless Function
 * PROTÓTIPO: "Ortofoto -> divisão de lotes"
 *
 * Mesma arquitetura de api/analisar-documento.js: recebe apenas a URL do
 * Vercel Blob (o arquivo nunca passa pelo corpo desta funcao) e pede ao
 * Claude (Anthropic) para PROPOR poligonos de lotes/unidades visiveis na
 * imagem, via tool_use forcado - nunca texto livre.
 *
 * Esta funcao NUNCA:
 *   - calcula area, perimetro ou qualquer geometria;
 *   - converte a proposta para coordenadas geograficas (a IA nao tem
 *     georreferencia da imagem - so ve pixels);
 *   - mantem a imagem salva: e apagada do Vercel Blob assim que a analise
 *     termina, com sucesso ou erro (bloco finally).
 *
 * Toda a matematica (area em px², georreferenciamento por pontos de
 * controle, exportacao) acontece no navegador, deterministicamente, em
 * lib/ortofoto.js. A IA so PROPOE vertices em coordenadas de pixel
 * normalizadas (0..1); o usuario edita livremente antes de exportar.
 *
 * A ANTHROPIC_API_KEY e reaproveitada da mesma variavel de ambiente usada
 * por api/analisar-documento.js - nenhuma configuracao nova e necessaria.
 * ---------------------------------------------------------------------------
 */
const { del } = require("@vercel/blob");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 8000;

// Protótipo: só imagens (uma ortofoto nunca chega como PDF). Reaproveita o
// mesmo Vercel Blob/endpoint de upload usado para matriculas.
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

const SYSTEM_INSTRUCTIONS = `
Voce e um especialista tecnico em fotointerpretacao de ortofotos (imagens
aereas) para apoio a divisao de lotes/unidades imobiliarias, para a empresa
Integral Solucoes em Engenharia.

Sua UNICA tarefa e PROPOR poligonos de possiveis lotes/unidades visiveis na
imagem, com base em evidencia visual DETERMINISTICA e objetivamente
observavel - nunca em suposicao sobre o uso do imovel ou em conhecimento
externo sobre a area, o municipio ou o proprietario.

EVIDENCIAS ACEITAS (cite qual foi usada em "evidencias" de cada poligono):
- muros e paredes divisorias visiveis;
- cercas (arame, tela, madeira) visiveis;
- alinhamentos de construcao/edificacao;
- mudanca abrupta de textura/cor do solo ou pavimento (ex: asfalto/terra,
  gramado/calcada) que indique um limite fisico;
- meios-fios, calcadas, vias de acesso;
- sombras que indiquem desnivel, muro ou degrau;
- numeracao/placas de lote pintadas ou visiveis na propria imagem.

REGRAS OBRIGATORIAS E INEGOCIAVEIS (regra fundamental contra alucinacao):
- NUNCA proponha uma divisao que nao tenha evidencia visual concreta e
  descritivel na propria imagem. Se a imagem nao mostrar nenhuma divisa
  clara, retorne "poligonos" como lista vazia e explique o motivo em
  "alertas" - nao invente uma divisao "provavel".
- NUNCA calcule area, perimetro ou qualquer metrica geometrica - isso e
  feito por outro modulo do sistema, deterministicamente, depois da sua
  resposta.
- NUNCA infira latitude/longitude nem qualquer coordenada geografica - voce
  esta vendo apenas uma imagem sem georreferencia. Trabalhe SOMENTE em
  coordenadas de pixel normalizadas.
- Para cada poligono, "vertices" deve ser uma lista ORDENADA (percorrendo o
  contorno em um unico sentido, horario ou anti-horario, sem repetir o
  primeiro ponto ao final) de pontos {x, y} normalizados entre 0 e 1, onde
  x=0 e a borda esquerda da imagem, x=1 a borda direita, y=0 o topo da
  imagem, y=1 a base.
- Cada poligono deve ter no minimo 3 e no maximo 30 vertices, seguindo
  fielmente o contorno fisico observado (nao arredonde cantos retos nem
  simplifique excessivamente um contorno irregular real).
- Preencha "evidencias" com 1 a 4 descricoes curtas e objetivas do que
  concretamente foi visto para justificar o tracado de CADA poligono (ex:
  "muro claro visivel ao longo do lado norte", "cerca de arame separando do
  lote vizinho a leste", "mudanca de pavimento (asfalto para terra) no lado
  sul").
- Preencha "confianca" entre 0 e 1 refletindo a nitidez da evidencia visual
  (reduza se a imagem tiver resolucao ruim, sombra, vegetacao cobrindo parte
  da divisa, ou o limite for so parcialmente visivel) - nunca use um valor
  fixo/generico.
- Se identificar MAIS de um lote/unidade na imagem, retorne um poligono para
  cada, com "rotulo" descritivo (ex: "Lote A", "Lote 12", "Unidade 3") -
  prefira reaproveitar numeracao/identificacao visivel na propria imagem
  quando houver, citando isso em "evidencias".
- Se parte do contorno estiver ocluida (vegetacao, sombra, corte da imagem)
  e isso impedir tracar o contorno completo com certeza, ainda assim proponha
  o melhor tracado possivel, registre a limitacao em "alertas" e reduza a
  confianca daquele poligono - NUNCA invente um trecho de contorno que nao
  seja visivel nem inferivel por continuidade direta de uma linha reta
  claramente visivel dos dois lados da oclusao.
- Preencha "observacoes_gerais" com um resumo tecnico curto (1-3 frases) da
  qualidade da imagem e da confiabilidade geral da proposta.
- Sua resposta deve ser SOMENTE a chamada da ferramenta
  "propor_divisao_lotes" com os dados propostos - nao responda com texto
  adicional.
`.trim();

const PROPOSAL_TOOL = {
  name: "propor_divisao_lotes",
  description:
    "Registra os poligonos de lotes/unidades PROPOSTOS a partir de evidencia visual observada na ortofoto " +
    "(muros, cercas, alinhamentos, mudanca de textura). Coordenadas sempre em pixel normalizado (0 a 1).",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["poligonos", "observacoes_gerais", "alertas"],
    properties: {
      poligonos: {
        type: "array",
        description: "Um item por lote/unidade identificado. Lista vazia se nenhuma divisa clara for visivel.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rotulo", "vertices", "evidencias", "confianca"],
          properties: {
            rotulo: { type: "string", description: "Identificacao curta, ex: 'Lote A', 'Lote 12'" },
            vertices: {
              type: "array",
              minItems: 3,
              maxItems: 30,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["x", "y"],
                properties: {
                  x: { type: "number", description: "0 a 1, da esquerda para a direita" },
                  y: { type: "number", description: "0 a 1, do topo para a base" }
                }
              }
            },
            evidencias: {
              type: "array",
              items: { type: "string" },
              description: "1 a 4 descricoes curtas e objetivas da evidencia visual usada para tracar este poligono."
            },
            confianca: { type: "number", description: "0 a 1, refletindo a nitidez da evidencia visual." }
          }
        }
      },
      observacoes_gerais: {
        type: ["string", "null"],
        description: "Resumo tecnico curto da qualidade da imagem e confiabilidade geral da proposta."
      },
      alertas: {
        type: "array",
        description: "Limitacoes, oclusoes, ou motivo de nao ter proposto nenhum poligono.",
        items: { type: "string" }
      }
    }
  }
};

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/** So aceitamos analisar URLs que sejam realmente do nosso Vercel Blob publico - evita uso desta function como proxy/SSRF. */
function isTrustedBlobUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch (e) {
    return false;
  }
}

function extractToolInput(anthropicResponse, toolName) {
  if (!Array.isArray(anthropicResponse.content)) return null;
  for (const block of anthropicResponse.content) {
    if (block.type === "tool_use" && block.name === toolName) {
      return block.input;
    }
  }
  return null;
}

async function callClaude(apiKey, model, filename, blobUrl) {
  const userContent = [
    { type: "image", source: { type: "url", url: blobUrl } },
    {
      type: "text",
      text:
        "Analise esta ortofoto (" +
        filename +
        ") e proponha a divisao de lotes/unidades visiveis usando a ferramenta " +
        "propor_divisao_lotes, seguindo rigorosamente as regras das instrucoes do sistema."
    }
  ];

  const anthropicPayload = {
    model: model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_INSTRUCTIONS,
    messages: [{ role: "user", content: userContent }],
    tools: [PROPOSAL_TOOL],
    tool_choice: { type: "tool", name: "propor_divisao_lotes" }
  };

  let anthropicRes;
  try {
    var headers = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    };
    if (process.env.ANTHROPIC_WORKSPACE_ID) {
      headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
    }
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(anthropicPayload)
    });
  } catch (err) {
    return { status: 502, payload: { erro: "Falha de rede ao contatar o Claude.", detalhe: String(err) } };
  }

  let anthropicJson;
  try {
    anthropicJson = await anthropicRes.json();
  } catch (err) {
    return { status: 502, payload: { erro: "Resposta invalida do Claude." } };
  }

  if (!anthropicRes.ok) {
    const msg =
      (anthropicJson && anthropicJson.error && anthropicJson.error.message) ||
      "Erro desconhecido ao chamar o Claude.";
    return { status: 502, payload: { erro: "Claude retornou um erro: " + msg } };
  }

  const extracted = extractToolInput(anthropicJson, "propor_divisao_lotes");
  if (!extracted) {
    return { status: 502, payload: { erro: "O Claude nao retornou uma proposta estruturada para esta imagem." } };
  }

  return { status: 200, payload: { sucesso: true, dados: extracted } };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { erro: "Metodo nao permitido. Use POST." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, {
      erro: "Configuracao ausente no servidor: ANTHROPIC_API_KEY nao foi definida."
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return sendJson(res, 400, { erro: "Corpo da requisicao invalido (JSON malformado)." });
    }
  }
  if (!body || typeof body !== "object") {
    return sendJson(res, 400, { erro: "Corpo da requisicao ausente." });
  }

  const { filename, mimeType, blobUrl } = body;

  if (!filename || !mimeType || !blobUrl) {
    return sendJson(res, 400, { erro: "Campos obrigatorios ausentes: filename, mimeType, blobUrl." });
  }

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return sendJson(res, 415, {
      erro: "Tipo de arquivo nao suportado (" + mimeType + "). Envie JPG, JPEG, PNG ou WEBP."
    });
  }

  if (!isTrustedBlobUrl(blobUrl)) {
    return sendJson(res, 400, { erro: "URL de arquivo invalida." });
  }

  // Mesma protecao de api/analisar-documento.js: autenticacao + acesso
  // interno liberado + rate limit, antes de gastar uma chamada de IA.
  const { checarRateLimit } = require("../server/rateLimit");
  const { getAuthenticatedUser, getUsuarioInterno } = require("../server/supabaseAdmin");

  let usuario;
  try {
    usuario = await getAuthenticatedUser(req);
  } catch (e) {
    return sendJson(res, 401, { erro: "Faca login para analisar ortofotos." });
  }

  try {
    await getUsuarioInterno(usuario.id);
  } catch (e) {
    return sendJson(res, e.statusCode || 403, { erro: e.message });
  }

  const limiteIp = await checarRateLimit(req, "analisar-ortofoto", 20, 15 * 60 * 1000);
  if (!limiteIp.permitido) {
    return sendJson(res, 429, { erro: "Muitas analises em pouco tempo deste endereco. Aguarde alguns minutos." });
  }

  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

  let result;
  try {
    result = await callClaude(apiKey, model, filename, blobUrl);
  } finally {
    // Regra do projeto: nao persistir imagens. Apaga do Blob assim que a
    // analise termina, com sucesso ou erro.
    try {
      await del(blobUrl);
    } catch (e) {
      // ignorado de proposito
    }
  }

  return sendJson(res, result.status, result.payload);
};
