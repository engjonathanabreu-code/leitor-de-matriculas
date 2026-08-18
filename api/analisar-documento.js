/**
 * api/analisar-documento.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA - Vercel Serverless Function
 *
 * Unica responsabilidade: enviar o documento (PDF ou imagem) para a OpenAI
 * e devolver o JSON estruturado com os dados IDENTIFICADOS no documento.
 *
 * Esta funcao NUNCA:
 *   - calcula area, perimetro ou geometria;
 *   - converte sistemas de coordenadas;
 *   - constroi a poligonal;
 *   - armazena o documento enviado (nada e persistido em disco/banco).
 *
 * Toda a matematica/geoprocessamento acontece no navegador, de forma
 * deterministica, em lib/coordinates.js e lib/geometry.js.
 *
 * A OPENAI_API_KEY existe apenas aqui (variavel de ambiente da Vercel) e
 * nunca e enviada ao navegador.
 * ---------------------------------------------------------------------------
 */

const OPENAI_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4o";
// ATENCAO: as Vercel Serverless Functions tem limite de corpo de requisicao
// de aprox. 4.5 MB (plano Hobby). Como o arquivo e enviado em Base64
// (overhead de ~33%) dentro de um JSON, o arquivo ORIGINAL precisa ficar
// bem abaixo desse limite. Ver README.md para detalhes e alternativas.
const DEFAULT_MAX_BYTES = 3 * 1000 * 1000; // 3 MB (arquivo original)

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
documento, estruturando-as no formato JSON solicitado.

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
- A numeracao/ID dos vertices no documento PODE NAO SER sequencial (ex.: a
  descricao pode ir do vertice 17 para o 27, depois descer 26, 25, 24... e
  depois pular para o 8). Isso e normal: em terrenos que fazem parte de um
  loteamento maior, a numeracao vem da planta geral do loteamento, nao da
  ordem de caminhamento daquele lote especifico. Um "salto" ou "volta" no
  numero NUNCA e motivo para pular, fundir, descartar ou desconfiar de um
  vertice - extraia TODOS os vertices mencionados na descricao perimetral,
  na ordem em que aparecem no texto, exatamente como aparecem, independente
  de o numero/ID crescer, cair ou pular.
- Antes de responder, CONTE quantas vezes a descricao perimetral menciona
  "ate o ponto X" (ou construcao equivalente, ex.: "ate 15", "ate o vertice
  X") somada ao vertice inicial de onde "inicia-se o perimetro". Confirme
  que o array "vertices" tem exatamente essa quantidade de itens. Se a
  contagem nao bater, releia a descricao perimetral com atencao e corrija
  antes de responder - nao responda com uma lista incompleta.
- Para cada vertice, preencha "texto_origem" com o trecho literal do
  documento de onde a coordenada/distancia/azimute foi retirada, para
  permitir auditoria humana.
- Para cada vertice, estime "confianca" entre 0 e 1 refletindo o quanto o
  texto original era claro e legivel (nunca use um valor fixo/generico).
- Coordenadas podem aparecer como: decimal (-26.337412), GMS
  (26°20'14.221"S), ou UTM (E/N ou X/Y). Preencha latitude/longitude OU
  easting/northing de acordo com o que estiver no documento - nunca calcule
  um a partir do outro.
- Voce NAO deve calcular area, perimetro, converter sistemas de coordenadas
  ou construir geometria. Isso e feito por outro modulo do sistema.
- Se o documento nao for um dos tipos esperados, ainda assim extraia o que
  for aplicavel e defina tipo_documento como "OUTRO".
- Responda SOMENTE com o JSON no formato definido pelo schema fornecido.
`.trim();

const RESPONSE_SCHEMA = {
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
};

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function estimateBase64Bytes(base64) {
  const len = base64.length;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

function extractOutputText(openAiResponse) {
  if (openAiResponse.output_text) return openAiResponse.output_text;
  if (Array.isArray(openAiResponse.output)) {
    for (const item of openAiResponse.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "output_text" && typeof c.text === "string") {
            return c.text;
          }
        }
      }
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { erro: "Metodo nao permitido. Use POST." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, {
      erro: "Configuracao ausente no servidor: OPENAI_API_KEY nao foi definida."
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

  const { filename, mimeType, dataBase64 } = body;

  if (!filename || !mimeType || !dataBase64) {
    return sendJson(res, 400, {
      erro: "Campos obrigatorios ausentes: filename, mimeType, dataBase64."
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

  const maxBytes = parseInt(process.env.MAX_FILE_SIZE_BYTES, 10) || DEFAULT_MAX_BYTES;
  const estimatedBytes = estimateBase64Bytes(dataBase64);
  if (estimatedBytes > maxBytes) {
    return sendJson(res, 413, {
      erro:
        "Arquivo muito grande (" +
        (estimatedBytes / 1000000).toFixed(2) +
        " MB). Limite atual: " +
        (maxBytes / 1000000).toFixed(2) +
        " MB."
    });
  }

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const isPdf = mimeType === "application/pdf";

  const userContent = isPdf
    ? [
        {
          type: "input_file",
          filename: filename,
          file_data: "data:" + mimeType + ";base64," + dataBase64
        },
        {
          type: "input_text",
          text:
            "Leia este documento fundiario e extraia os dados no formato JSON definido, " +
            "seguindo rigorosamente as regras fornecidas nas instrucoes do sistema."
        }
      ]
    : [
        {
          type: "input_image",
          image_url: "data:" + mimeType + ";base64," + dataBase64
        },
        {
          type: "input_text",
          text:
            "Leia esta imagem de documento fundiario e extraia os dados no formato JSON definido, " +
            "seguindo rigorosamente as regras fornecidas nas instrucoes do sistema."
        }
      ];

  const openAiPayload = {
    model: model,
    instructions: SYSTEM_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: userContent
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "extracao_matricula",
        schema: RESPONSE_SCHEMA,
        strict: true
      }
    }
  };

  let openAiRes;
  try {
    openAiRes = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey
      },
      body: JSON.stringify(openAiPayload)
    });
  } catch (err) {
    return sendJson(res, 502, { erro: "Falha de rede ao contatar a OpenAI.", detalhe: String(err) });
  }

  let openAiJson;
  try {
    openAiJson = await openAiRes.json();
  } catch (err) {
    return sendJson(res, 502, { erro: "Resposta invalida da OpenAI." });
  }

  if (!openAiRes.ok) {
    const msg =
      (openAiJson && openAiJson.error && openAiJson.error.message) ||
      "Erro desconhecido ao chamar a OpenAI.";
    return sendJson(res, 502, { erro: "OpenAI retornou um erro: " + msg });
  }

  const outputText = extractOutputText(openAiJson);
  if (!outputText) {
    return sendJson(res, 502, { erro: "A OpenAI nao retornou conteudo estruturado para este documento." });
  }

  let extracted;
  try {
    extracted = JSON.parse(outputText);
  } catch (err) {
    return sendJson(res, 502, { erro: "Nao foi possivel interpretar o JSON retornado pela IA." });
  }

  return sendJson(res, 200, { sucesso: true, dados: extracted });
};
