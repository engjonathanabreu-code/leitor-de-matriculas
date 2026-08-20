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

const SYSTEM_INSTRUCTIONS = `
Voce e um especialista tecnico em leitura de documentos fundiarios brasileiros
(matriculas imobiliarias, memoriais descritivos, escrituras) para a empresa
Integral Solucoes em Engenharia.

Sua UNICA tarefa e IDENTIFICAR e EXTRAIR informacoes literalmente presentes no
documento, estruturando-as atraves da ferramenta "extrair_dados_matricula".

REGRAS OBRIGATORIAS E INEGOCIAVEIS (regra fundamental contra alucinacao):
- Nunca invente coordenadas.
- Nunca complete digitos ilegiveis ou parcialmente visiveis.
- Nunca invente numero de matricula.
- Nunca invente datum.
- Nunca invente zona UTM.
- Nunca invente EPSG.
- Nunca invente confrontante.
- Nunca presuma zona UTM ou datum quando eles nao estiverem explicitos no texto.
- Quando uma informacao nao puder ser determinada com seguranca, retorne null
  nesse campo e descreva o problema em "alertas".
- Preserve RIGOROSAMENTE a ordem em que os vertices aparecem na descricao
  perimetral do documento. NUNCA reordene vertices por latitude, longitude,
  numero ou proximidade.
- Para cada vertice, preencha "texto_origem" com o trecho literal do
  documento de onde a coordenada/distancia/azimute foi retirada, para
  permitir auditoria humana.
- Para cada vertice, estime "confianca" entre 0 e 1 refletindo o quanto o
  texto original era claro e legivel (nunca use um valor fixo/generico).
- Coordenadas podem aparecer como: decimal (-26.337412), GMS
  (26Â°20'14.221"S), ou UTM (E/N ou X/Y). Preencha latitude/longitude OU
  easting/northing de acordo com o que estiver no documento - nunca calcule
  um a partir do outro.
- Voce NAO deve calcular area, perimetro, converter sistemas de coordenadas
  ou construir geometria. Isso e feito por outro modulo do sistema.
- Se o documento nao for um dos tipos esperados, ainda assim extraia o que
  for aplicavel e defina tipo_documento como "OUTRO".
- Sua resposta deve ser SOMENTE a chamada da ferramenta "extrair_dados_matricula"
  com os dados extraidos - nao responda com texto adicional.
`.trim();

// Mesma estrutura de dados usada antes (schema JSON), agora como
// input_schema de uma tool da Anthropic em vez de response_format da OpenAI.
const EXTRACTION_TOOL = {
  name: "extrair_dados_matricula",
  description:
    "Registra os dados IDENTIFICADOS e EXTRAIDOS do documento fundiario (matricula, memorial descritivo, etc). " +
    "Preencha apenas o que estiver literalmente presente no documento; use null quando nao houver certeza.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "tipo_documento",
      "matricula",
      "proprietario",
      "imovel",
      "sistema_coordenadas",
      "vertices",
      "confrontantes",
      "alertas"
    ],
    properties: {
      tipo_documento: {
        type: "string",
        enum: [
          "MATRICULA_IMOVEL",
          "MEMORIAL_DESCRITIVO",
          "ESCRITURA",
          "CONTRATO",
          "PLANTA",
          "OUTRO"
        ]
      },
      matricula: {
        type: "object",
        additionalProperties: false,
        required: ["numero", "cartorio", "comarca", "municipio", "estado"],
        properties: {
          numero: { type: ["string", "null"] },
          cartorio: { type: ["string", "null"] },
          comarca: { type: ["string", "null"] },
          municipio: { type: ["string", "null"] },
          estado: { type: ["string", "null"], description: "Sigla UF, ex: SC" }
        }
      },
      proprietario: {
        type: "object",
        additionalProperties: false,
        required: ["nome", "cpf", "cnpj"],
        properties: {
          nome: { type: ["string", "null"] },
          cpf: { type: ["string", "null"] },
          cnpj: { type: ["string", "null"] }
        }
      },
      imovel: {
        type: "object",
        additionalProperties: false,
        required: ["descricao", "endereco", "lote", "quadra", "area_registral", "unidade_area"],
        properties: {
          descricao: { type: ["string", "null"] },
          endereco: { type: ["string", "null"] },
          lote: { type: ["string", "null"] },
          quadra: { type: ["string", "null"] },
          area_registral: { type: ["number", "null"] },
          unidade_area: { type: ["string", "null"], description: "ex: m2, ha" }
        }
      },
      sistema_coordenadas: {
        type: "object",
        additionalProperties: false,
        required: ["tipo", "datum", "epsg", "zona", "hemisferio"],
        properties: {
          tipo: {
            type: ["string", "null"],
            description: "UTM, GEOGRAFICA (lat/long) ou null se nao identificado"
          },
          datum: { type: ["string", "null"], description: "ex: SIRGAS2000, SAD69, WGS84" },
          epsg: { type: ["string", "null"] },
          zona: { type: ["number", "null"] },
          hemisferio: { type: ["string", "null"], description: "N ou S" }
        }
      },
      vertices: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "latitude",
            "longitude",
            "easting",
            "northing",
            "distancia_para_proximo",
            "azimute_para_proximo",
            "rumo_para_proximo",
            "confrontante_para_proximo",
            "texto_origem",
            "confianca"
          ],
          properties: {
            id: { type: "string", description: "ex: V01" },
            latitude: { type: ["number", "null"] },
            longitude: { type: ["number", "null"] },
            easting: { type: ["number", "null"] },
            northing: { type: ["number", "null"] },
            distancia_para_proximo: { type: ["number", "null"], description: "metros, ate o proximo vertice" },
            azimute_para_proximo: { type: ["string", "null"] },
            rumo_para_proximo: { type: ["string", "null"] },
            confrontante_para_proximo: { type: ["string", "null"] },
            texto_origem: { type: ["string", "null"] },
            confianca: { type: "number" }
          }
        }
      },
      confrontantes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["vertice_inicial", "vertice_final", "nome", "tipo", "distancia", "azimute"],
          properties: {
            vertice_inicial: { type: ["string", "null"] },
            vertice_final: { type: ["string", "null"] },
            nome: { type: ["string", "null"] },
            tipo: {
              type: ["string", "null"],
              description: "PARTICULAR, RUA, RODOVIA, RIO, CORREGO, AREA_PUBLICA ou OUTRO"
            },
            distancia: { type: ["number", "null"] },
            azimute: { type: ["string", "null"] }
          }
        }
      },
      alertas: {
        type: "array",
        description: "Mensagens sobre informacoes ausentes, ambiguas ou nao determinaveis com seguranca.",
        items: { type: "string" }
      }
    }
  }
};

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
    system: SYSTEM_INSTRUCTIONS,
    messages: [{ role: "user", content: userContent }],
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "extrair_dados_matricula" }
  };

  let anthropicRes;
  try {
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
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
