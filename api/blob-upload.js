/**
 * api/blob-upload.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA - Vercel Serverless Function
 *
 * As Vercel Serverless Functions tem limite fixo de 4.5 MB para o corpo da
 * requisicao (nao e configuravel, e um limite de infraestrutura). Como
 * matriculas escaneadas costumam passar de 10 MB, o arquivo NUNCA passa por
 * esta ou por api/analisar-documento.js: o navegador envia o arquivo DIRETO
 * para o Vercel Blob (storage), e esta funcao apenas autoriza esse upload
 * (emite um token de curta duracao).
 *
 * Fluxo:
 *   1. Navegador chama upload() do pacote @vercel/blob/client.
 *   2. Esse helper faz um POST aqui pedindo um token ("blob.generate-client-token").
 *   3. Validamos tipo/tamanho do arquivo e devolvemos o token.
 *   4. O navegador envia o arquivo direto para o Vercel Blob usando o token.
 *   5. O arquivo e apagado por api/analisar-documento.js assim que a analise
 *      termina - nada fica armazenado.
 *
 * Requer a variavel de ambiente BLOB_READ_WRITE_TOKEN, criada
 * automaticamente pela Vercel quando um Blob Store e conectado ao projeto
 * (aba Storage do projeto -> Create Database -> Blob).
 * ---------------------------------------------------------------------------
 */
const { handleUpload } = require("@vercel/blob/client");

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp"
];

const DEFAULT_MAX_BYTES = 20 * 1000 * 1000; // 20 MB (bem abaixo do limite de 50 MB da OpenAI por arquivo)

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { erro: "Metodo nao permitido. Use POST." });
  }

  const maxBytes = parseInt(process.env.MAX_FILE_SIZE_BYTES, 10) || DEFAULT_MAX_BYTES;

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async function () {
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: maxBytes,
          addRandomSuffix: true,
          // O arquivo precisa ser publicamente legivel para que a OpenAI
          // consiga busca-lo pela URL (file_url/image_url). Nenhum dado do
          // documento fica no nome do arquivo (nomes sao aleatorizados).
          tokenPayload: JSON.stringify({})
        };
      },
      onUploadCompleted: async function () {
        // Nada a fazer aqui: o arquivo e apagado em api/analisar-documento.js
        // assim que a analise termina (sucesso ou erro). Nao mantemos
        // nenhum registro/banco de dados dos uploads.
      }
    });

    return sendJson(res, 200, jsonResponse);
  } catch (err) {
    return sendJson(res, 400, {
      erro: (err && err.message) || "Falha ao gerar token de upload."
    });
  }
};
