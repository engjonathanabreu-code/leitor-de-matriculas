/**
 * offline-app/server.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA - Aplicacao OFFLINE: "Ortofoto -> divisao de lotes"
 *
 * Por que esta aplicacao existe:
 * a aba "Ortofoto" do leitor-de-matriculas (hospedado na Vercel) roda inteira
 * no navegador, o que funciona bem ate uns 40 MB. Ortofotos reais (drone,
 * levantamento aerofotogrametrico) costumam vir como GeoTIFF de centenas de
 * MB - o navegador simplesmente nao consegue decodificar um arquivo desse
 * tamanho sem travar a aba (limite de memoria da pagina, upload por HTTP,
 * limite de 4.5 MB do corpo de uma funcao serverless da Vercel, etc.).
 *
 * A solucao aqui e rodar um servidor Node PEQUENO, na propria maquina do
 * usuario, que:
 *   1. Le o arquivo de ortofoto DIRETO DO DISCO, pelo caminho local (nunca
 *      passa pelo navegador nem por upload HTTP - o arquivo original de
 *      600+ MB nunca trafega pela rede nem entra na memoria do processo
 *      inteiro de uma vez: a biblioteca "sharp" (libvips) decodifica em
 *      streaming e ja reduz a resolucao durante a leitura);
 *   2. Gera, localmente, uma copia PEQUENA (poucos MB) da imagem, em duas
 *      variantes: uma para EXIBIR no navegador (maior, so para o usuario
 *      ver/editar) e uma para ANALISE por IA (menor, dentro dos limites de
 *      visao da Anthropic);
 *   3. Envia SOMENTE essa copia pequena para a API da Anthropic (Claude),
 *      pedindo para propor poligonos de lotes - exatamente o mesmo
 *      tool_choice forcado, mesmo prompt e mesmo schema de
 *      api/analisar-ortofoto.js (o modulo irmao deste, que roda na Vercel).
 *
 * Continua valendo a regra do projeto inteiro: "a IA nunca calcula
 * geometria". A IA so devolve poligonos em coordenadas de pixel normalizadas
 * (0 a 1); toda a matematica (area, perimetro, georreferenciamento por 2
 * pontos de controle, exportacao) roda no navegador, em lib/ortofoto.js -
 * o MESMO arquivo usado pela aba web, copiado sem alteracoes.
 *
 * Nada e enviado a nenhum servidor da Integral/Vercel/Supabase. O unico
 * destino de rede e api.anthropic.com, e so da copia ja reduzida da imagem.
 * ---------------------------------------------------------------------------
 */
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const sharp = require("sharp");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 8000;

// Mesma logica de formatos de leitor-de-matriculas/app.js (ORTOFOTO_EXTENSOES_ACEITAS).
const EXTENSOES_ACEITAS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

// Dimensoes-alvo (lado maior, em pixels) das duas copias reduzidas geradas
// localmente. A copia de EXIBICAO fica maior (para o usuario examinar/editar
// com conforto); a de ANALISE fica proxima do teto interno da visao da
// Anthropic (~1568-2576px de lado maior) - mandar mais que isso so gasta
// banda/tempo sem ganhar precisao, pois a propria API reduz internamente.
const DISPLAY_MAX_DIM = 3200;
const ANALISE_MAX_DIM = 2000;
const ANALISE_MAX_BYTES = 9 * 1000 * 1000; // margem de seguranca abaixo do limite de 10 MB da Anthropic (imagem em base64)

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

function extensaoDe(caminho) {
  return path.extname(caminho || "").toLowerCase();
}

/** Confere se o caminho existe, e um arquivo (nao diretorio) e tem extensao aceita - evita ler qualquer outra coisa do disco do usuario. */
function validarCaminhoImagem(caminho) {
  if (!caminho || typeof caminho !== "string") return "Informe o caminho completo do arquivo.";
  if (!EXTENSOES_ACEITAS.has(extensaoDe(caminho))) {
    return "Formato não suportado. Envie JPG, PNG, WEBP, GIF, BMP ou TIFF/GeoTIFF.";
  }
  let stat;
  try {
    stat = fs.statSync(caminho);
  } catch (e) {
    return "Arquivo não encontrado neste caminho. Confira se o caminho está completo e correto.";
  }
  if (!stat.isFile()) return "O caminho informado não é um arquivo.";
  return null;
}

/**
 * Decodifica (via sharp/libvips, em streaming - nunca materializa o arquivo
 * inteiro em um unico buffer) e reduz a imagem para, no maximo, "maxDim" de
 * lado maior, devolvendo um JPEG. limitInputPixels:false remove o teto padrao
 * do sharp (~268 megapixels), necessario para ortomosaicos grandes.
 */
async function reduzirImagem(caminho, maxDim, qualidade) {
  const instancia = sharp(caminho, { limitInputPixels: false, unlimited: true }).rotate();
  const { data, info } = await instancia
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }) // remove canal alpha antes de virar JPEG (TIFF/PNG podem ter transparencia)
    .jpeg({ quality: qualidade, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, largura: info.width, altura: info.height };
}

/** Garante que a copia de ANALISE fica abaixo do limite de tamanho da Anthropic, baixando a qualidade/dimensao se preciso. */
async function reduzirParaAnalise(caminho) {
  let dim = ANALISE_MAX_DIM;
  let qualidade = 85;
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const resultado = await reduzirImagem(caminho, dim, qualidade);
    if (resultado.buffer.length <= ANALISE_MAX_BYTES) return resultado;
    dim = Math.round(dim * 0.8);
    qualidade = Math.max(50, qualidade - 10);
  }
  return reduzirImagem(caminho, 1200, 50);
}

function extractToolInput(anthropicResponse, toolName) {
  if (!Array.isArray(anthropicResponse.content)) return null;
  for (const block of anthropicResponse.content) {
    if (block.type === "tool_use" && block.name === toolName) return block.input;
  }
  return null;
}

async function callClaude(apiKey, model, nomeArquivo, imagemBase64) {
  const userContent = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imagemBase64 } },
    {
      type: "text",
      text:
        "Analise esta ortofoto (" +
        nomeArquivo +
        ") e proponha a divisao de lotes/unidades visiveis usando a ferramenta " +
        "propor_divisao_lotes, seguindo rigorosamente as regras das instrucoes do sistema."
    }
  ];

  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION
  };
  if (process.env.ANTHROPIC_WORKSPACE_ID) headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;

  let anthropicRes;
  try {
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_INSTRUCTIONS,
        messages: [{ role: "user", content: userContent }],
        tools: [PROPOSAL_TOOL],
        tool_choice: { type: "tool", name: "propor_divisao_lotes" }
      })
    });
  } catch (err) {
    const erro = new Error("Falha de rede ao contatar o Claude. Confira sua conexão com a internet.");
    erro.status = 502;
    throw erro;
  }

  let anthropicJson;
  try {
    anthropicJson = await anthropicRes.json();
  } catch (err) {
    const erro = new Error("Resposta inválida do Claude.");
    erro.status = 502;
    throw erro;
  }

  if (!anthropicRes.ok) {
    const msg = (anthropicJson && anthropicJson.error && anthropicJson.error.message) || "Erro desconhecido ao chamar o Claude.";
    const erro = new Error("Claude retornou um erro: " + msg);
    erro.status = 502;
    throw erro;
  }

  const extraido = extractToolInput(anthropicJson, "propor_divisao_lotes");
  if (!extraido) {
    const erro = new Error("O Claude não retornou uma proposta estruturada para esta imagem.");
    erro.status = 502;
    throw erro;
  }
  return extraido;
}

// -----------------------------------------------------------------------
// Servidor HTTP
// -----------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "2mb" })); // so trafega JSON pequeno (caminhos, respostas da IA) - o arquivo de imagem nunca passa pelo corpo HTTP
app.use(express.static(path.join(__dirname, "public")));
app.use("/lib", express.static(path.join(__dirname, "lib")));

function sendErro(res, status, mensagem) {
  res.status(status).json({ erro: mensagem });
}

/** Locais de partida uteis para o navegador de pastas (so os que existirem nesta maquina). */
app.get("/api/atalhos", (req, res) => {
  const home = os.homedir();
  const candidatos = [
    { rotulo: "Início", caminho: home },
    { rotulo: "Downloads", caminho: path.join(home, "Downloads") },
    { rotulo: "Área de trabalho", caminho: path.join(home, "Desktop") },
    { rotulo: "Documentos", caminho: path.join(home, "Documents") },
    { rotulo: "Documentos", caminho: path.join(home, "Documentos") }
  ];
  const atalhos = [];
  const vistos = new Set();
  for (const c of candidatos) {
    if (vistos.has(c.caminho)) continue;
    try {
      if (fs.statSync(c.caminho).isDirectory()) {
        atalhos.push(c);
        vistos.add(c.caminho);
      }
    } catch (e) {
      /* pasta nao existe nesta maquina - ignora */
    }
  }
  res.json({ atalhos, home });
});

/** Navegador de pastas simples: lista subpastas e arquivos de imagem elegiveis de um diretorio. */
app.get("/api/listar", (req, res) => {
  const caminho = req.query.caminho ? String(req.query.caminho) : os.homedir();
  let entradas;
  try {
    entradas = fs.readdirSync(caminho, { withFileTypes: true });
  } catch (e) {
    return sendErro(res, 400, "Não foi possível abrir esta pasta: " + (e.message || e));
  }
  const pastas = [];
  const arquivos = [];
  for (const ent of entradas) {
    if (ent.name.startsWith(".")) continue; // oculta arquivos/pastas de sistema (ex: .git)
    const completo = path.join(caminho, ent.name);
    if (ent.isDirectory()) {
      pastas.push({ nome: ent.name, caminho: completo });
    } else if (ent.isFile() && EXTENSOES_ACEITAS.has(extensaoDe(ent.name))) {
      let tamanho = null;
      try {
        tamanho = fs.statSync(completo).size;
      } catch (e) {}
      arquivos.push({ nome: ent.name, caminho: completo, tamanho });
    }
  }
  pastas.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  arquivos.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const pai = path.dirname(caminho);
  res.json({ caminho, pai: pai === caminho ? null : pai, pastas, arquivos });
});

/** Carrega e reduz uma imagem so para exibicao/edicao (sem gastar chamada de IA). */
app.post("/api/carregar-imagem", async (req, res) => {
  const caminho = req.body && req.body.caminho;
  const erroValidacao = validarCaminhoImagem(caminho);
  if (erroValidacao) return sendErro(res, 400, erroValidacao);

  try {
    const stat = fs.statSync(caminho);
    const { buffer, largura, altura } = await reduzirImagem(caminho, DISPLAY_MAX_DIM, 90);
    res.json({
      sucesso: true,
      nomeArquivo: path.basename(caminho),
      tamanhoOriginalBytes: stat.size,
      largura,
      altura,
      dataUrl: "data:image/jpeg;base64," + buffer.toString("base64")
    });
  } catch (e) {
    res.status(422).json({
      erro:
        "Não foi possível ler esta imagem (" + (e && e.message ? e.message : "erro desconhecido") + "). " +
        "Se for um TIFF com compressão pouco comum, tente reexportá-lo como GeoTIFF padrão (LZW/Deflate) ou como JPEG/PNG em seu software de origem (Pix4D/DroneDeploy/QGIS)."
    });
  }
});

/** Fluxo completo: reduz para analise, chama o Claude, devolve a proposta (poligonos em 0..1 - a matematica continua so no navegador). */
app.post("/api/analisar-ortofoto", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return sendErro(res, 500, "Configuração ausente: defina ANTHROPIC_API_KEY no arquivo .env desta pasta (offline-app/.env).");
  }
  const caminho = req.body && req.body.caminho;
  const erroValidacao = validarCaminhoImagem(caminho);
  if (erroValidacao) return sendErro(res, 400, erroValidacao);

  try {
    const { buffer } = await reduzirParaAnalise(caminho);
    const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
    const dados = await callClaude(apiKey, model, path.basename(caminho), buffer.toString("base64"));
    res.json({ sucesso: true, dados });
  } catch (e) {
    res.status(e.status || 500).json({ erro: (e && e.message) || "Falha ao detectar divisas." });
  }
});

const PORT = process.env.PORT || 5175;
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log("");
  console.log("  Integral Geo Matricula - Ortofoto (offline)");
  console.log("  -> http://" + HOST + ":" + PORT);
  console.log("");
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("  AVISO: ANTHROPIC_API_KEY não definida. Copie .env.example para .env e preencha antes de usar \"Detectar divisas com IA\".");
    console.log("");
  }
});
