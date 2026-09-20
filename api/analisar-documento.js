/**
 * api/analisar-documento.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA - Vercel Serverless Function
 *
 * Unica responsabilidade: pegar a URL do documento (ja enviado pelo
 * navegador DIRETO ao Vercel Blob em api/blob-upload.js) e mandar essa URL
 * para o Claude (Anthropic) analisar, devolvendo o JSON estruturado com os
 * dados IDENTIFICADOS no documento.
 *
 * O arquivo NUNCA passa pelo corpo desta funcao - so a URL publica do Blob
 * (um payload minusculo). Por isso o limite de 4.5 MB das Serverless
 * Functions da Vercel nao se aplica ao tamanho do documento.
 *
 * Esta funcao NUNCA:
 *   - calcula area, perimetro ou geometria;
 *   - converte sistemas de coordenadas;
 *   - constroi a poligonal;
 *   - MANTEM o documento salvo: o arquivo e apagado do Vercel Blob assim
 *     que a analise termina, com sucesso ou erro (ver bloco finally).
 *
 * Toda a matematica/geoprocessamento acontece no navegador, de forma
 * deterministica, em lib/coordinates.js e lib/geometry.js.
 *
 * A ANTHROPIC_API_KEY existe apenas aqui (variavel de ambiente da Vercel) e
 * nunca e enviada ao navegador.
 *
 * SAIDA ESTRUTURADA: em vez de pedir "responda em JSON" em texto livre,
 * forcamos o Claude a chamar uma unica ferramenta ("tool") cujo
 * input_schema e exatamente o formato que precisamos. Isso e mais
 * confiavel do que fazer parsing de um bloco de texto solto - o campo
 * `input` do bloco tool_use ja vem como objeto JSON, sem risco de vir com
 * texto extra em volta ou markdown.
 * ---------------------------------------------------------------------------
 */
const { del } = require("@vercel/blob");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Modelo padrao: bom equilibrio entre precisao e custo para leitura de
// documentos tecnicos. Para o maximo de precisao possivel (documentos
// dificeis, letra pequena, digitalizacoes ruins), defina a variavel de
// ambiente CLAUDE_MODEL=claude-opus-4-8 no projeto da Vercel.
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 16000;

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp"
]);

const { SYSTEM_INSTRUCTIONS, EXTRACTION_TOOL } = require("../server/extracaoMatricula");

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/**
 * So aceitamos analisar URLs que sejam realmente do nosso Vercel Blob
 * publico (nunca uma URL arbitraria vinda do cliente) - evita que esta
 * function seja usada como proxy/SSRF para o Claude buscar qualquer URL,
 * e garante que del() so tente apagar arquivos que sao realmente nossos.
 */
function isTrustedBlobUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch (e) {
    return false;
  }
}

/** Procura o primeiro bloco tool_use com o nome esperado e devolve seu "input" (ja e objeto, nao string). */
function extractToolInput(anthropicResponse, toolName) {
  if (!Array.isArray(anthropicResponse.content)) return null;
  for (const block of anthropicResponse.content) {
    if (block.type === "tool_use" && block.name === toolName) {
      return block.input;
    }
  }
  return null;
}

/** Chama o Claude e devolve { status, payload }. Nunca lanca "cru": erros viram um payload de erro estruturado. */
async function callClaude(apiKey, model, filename, mimeType, blobUrl) {
  const isPdf = mimeType === "application/pdf";

  const userContent = isPdf
    ? [
        {
          type: "document",
          source: { type: "url", url: blobUrl }
        },
        {
          type: "text",
          text:
            "Leia este documento fundiario (" +
            filename +
            ") e registre os dados usando a ferramenta extrair_dados_matricula, " +
            "seguindo rigorosamente as regras das instrucoes do sistema."
        }
      ]
    : [
        {
          type: "image",
          source: { type: "url", url: blobUrl }
        },
        {
          type: "text",
          text:
            "Leia esta imagem de documento fundiario (" +
            filename +
            ") e registre os dados usando a ferramenta extrair_dados_matricula, " +
            "seguindo rigorosamente as regras das instrucoes do sistema."
        }
      ];

  const anthropicPayload = {
    model: model,
    max_tokens: MAX_TOKENS,
    // Nota: "temperature" foi removido daqui de proposito - o modelo em uso
    // rejeita esse parametro ("`temperature` is deprecated for this model").
    // A consistencia da extracao entre analises repetidas do mesmo documento
    // e reforcada via instrucao explicita no SYSTEM_INSTRUCTIONS (contar os
    // vertices antes de responder), nao via parametro de amostragem.
    system: SYSTEM_INSTRUCTIONS,
    messages: [{ role: "user", content: userContent }],
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "extrair_dados_matricula" }
  };

  let anthropicRes;
  try {
    var headers = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    };
    // Chaves de API "identity-linked" (pessoais ou de service account) que
    // atuam em mais de um workspace exigem informar em qual workspace a
    // chamada deve rodar. Configure ANTHROPIC_WORKSPACE_ID nas variaveis de
    // ambiente da Vercel com o ID (comeca com "wrkspc_") do workspace onde
    // a chave foi criada - encontrado em console.anthropic.com > Settings >
    // Workspaces. Chaves antigas de workspace unico nao precisam disso.
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

  const extracted = extractToolInput(anthropicJson, "extrair_dados_matricula");
  if (!extracted) {
    return { status: 502, payload: { erro: "O Claude nao retornou dados estruturados para este documento." } };
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
    return sendJson(res, 400, {
      erro: "Campos obrigatorios ausentes: filename, mimeType, blobUrl."
    });
  }

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return sendJson(res, 415, {
      erro:
        "Tipo de arquivo nao suportado (" +
        mimeType +
        "). Envie PDF, JPG, JPEG, PNG ou WEBP."
    });
  }

  if (!isTrustedBlobUrl(blobUrl)) {
    return sendJson(res, 400, { erro: "URL de arquivo invalida." });
  }

  // =========================================================================
  // PROTECAO: autenticacao + acesso interno liberado + rate limit
  // Sistema de uso interno (Integral): sem plano pago, sem CAPTCHA publico
  // (nao ha cadastro aberto ao publico). So quem foi explicitamente liberado
  // por um administrador na tabela matriculaia_usuarios consegue analisar.
  // Tudo isso roda ANTES de chamar a IA (que custa dinheiro por chamada).
  // =========================================================================
  const { checarRateLimit } = require("../server/rateLimit");
  const { getAuthenticatedUser, getUsuarioInterno } = require("../server/supabaseAdmin");

  let usuario;
  try {
    usuario = await getAuthenticatedUser(req);
  } catch (e) {
    return sendJson(res, 401, { erro: "Faca login para analisar documentos." });
  }

  try {
    await getUsuarioInterno(usuario.id);
  } catch (e) {
    return sendJson(res, e.statusCode || 403, { erro: e.message });
  }

  const limiteIp = await checarRateLimit(req, "analisar-documento", 30, 15 * 60 * 1000);
  if (!limiteIp.permitido) {
    return sendJson(res, 429, { erro: "Muitas analises em pouco tempo deste endereco. Aguarde alguns minutos." });
  }

  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

  let result;
  try {
    result = await callClaude(apiKey, model, filename, mimeType, blobUrl);
  } finally {
    // Regra do projeto: nao persistir documentos. Apaga o arquivo do Blob
    // assim que a analise termina, com sucesso ou erro. Melhor esforco:
    // se a exclusao falhar, isso nao deve derrubar a resposta ao usuario
    // (o arquivo tem nome aleatorio e nao fica listado publicamente).
    try {
      await del(blobUrl);
    } catch (e) {
      // ignorado de proposito
    }
  }

  return sendJson(res, result.status, result.payload);
};
