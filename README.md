
Abra `http://localhost:3000`.

---

## 5. Passo a passo de deploy (GitHub → Vercel)

### 5.1. Criar o repositório no GitHub

```bash
cd integral-geo-matricula
git init
git add .
git commit -m "INTEGRAL GEO MATRICULA - versao inicial"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/integral-geo-matricula.git
git push -u origin main
```

### 5.2. Importar na Vercel

1. Acesse [vercel.com](https://vercel.com) e faça login.
2. Clique em **Add New → Project**.
3. Selecione o repositório `integral-geo-matricula` no GitHub.
4. Em **Framework Preset**, deixe **Other** (não é um framework específico).
5. Não é necessário alterar Build/Output Settings — não há passo de build.

### 5.3. Cadastrar a variável `OPENAI_API_KEY`

Antes de clicar em Deploy (ou depois, em Project Settings):

1. Vá em **Settings → Environment Variables**.
2. Adicione:
   - `OPENAI_API_KEY` = sua chave secreta da OpenAI (nunca a coloque no
     código ou no `.env.example`).
   - `OPENAI_MODEL` = `gpt-4o` (ou outro modelo com suporte a arquivos/visão
     via Responses API).
   - `MAX_FILE_SIZE_BYTES` = `3000000` (ajuste conforme necessário).
3. Marque para os ambientes **Production**, **Preview** e **Development**.

### 5.4. Deploy

Clique em **Deploy**. Após a build, a Vercel fornece uma URL pública
(`https://integral-geo-matricula-xxxx.vercel.app`). Não há login: qualquer
pessoa com o endereço pode usar a aplicação.

### 5.5. Primeiro teste com uma matrícula real

1. Abra a URL da aplicação.
2. Na aba **Nova análise**, envie um PDF de matrícula ou memorial descritivo
   real (ou uma foto/scan em JPG/PNG).
3. Clique em **Analisar documento** e acompanhe o fluxo visual.
4. Confira em **Dados extraídos** se número de matrícula, proprietário e
   sistema de referência foram lidos corretamente — e leia o trecho de
   evidência de cada vértice.
5. Vá em **Mapa** e confira visualmente se a poligonal está sobre o imóvel
   esperado. Corrija manualmente qualquer coordenada suspeita na tabela.
6. Em **Validação**, revise os alertas (✓ válido / ⚠ atenção / ✕ erro).
7. Em **Exportação**, baixe o GeoJSON/KML/CSV/TXT conforme necessário.

---

## 6. Segurança

- `OPENAI_API_KEY` só existe como variável de ambiente da Vercel, lida em
  `api/analisar-documento.js` (`process.env.OPENAI_API_KEY`). Nunca é
  incluída em nenhum arquivo servido ao navegador.
- O endpoint valida `mimeType` (lista branca) e tamanho do arquivo antes de
  chamar a OpenAI.
- Nenhum documento é armazenado em disco, banco de dados ou logs
  persistentes pela aplicação.
- Não há autenticação/login nesta versão — quem tiver o endereço da
  aplicação pode utilizá-la. Se isso não for desejável, considere colocar a
  aplicação atrás de Vercel Authentication/Password Protection ou de uma
  VPN interna (fora do escopo deste MVP).

---

## 7. Créditos de mapas

- Camada "Mapa": OpenStreetMap (`{s}.tile.openstreetmap.org`).
- Camada "Satélite": Esri World Imagery (`server.arcgisonline.com`), serviço
  público gratuito para uso geral — sem necessidade de chave de API.

---

## 8. Protótipo: Ortofoto → divisão de lotes

Aba **"Ortofoto"** (marcada como *Protótipo* na navegação): o usuário envia uma
ortofoto (imagem aérea) e a IA propõe polígonos de lotes/unidades com base em
evidência visual determinística (muros, cercas, alinhamentos de construção,
mudança de textura/pavimento, meios-fios). A proposta é sempre editável na
tela antes de qualquer exportação.

**Arquitetura** (mesmo padrão do restante do sistema — IA só identifica,
matemática é sempre determinística):

- `api/analisar-ortofoto.js` — mesma estrutura de `api/analisar-documento.js`
  (upload direto ao Vercel Blob, chamada ao Claude com `tool_choice` forçado,
  arquivo apagado do Blob ao final). A IA retorna **somente** polígonos em
  coordenadas de pixel normalizadas (0 a 1) com a evidência visual usada e um
  nível de confiança — nunca calcula área, nunca infere coordenada geográfica.
- `lib/ortofoto.js` — camada determinística no navegador: área/perímetro em
  pixel² (fórmula do shoelace), georreferenciamento aproximado por 2 pontos de
  controle (transformação de similaridade/Helmert), e geração de GeoJSON/SVG
  para exportação.
- Editor de vértices em SVG sobreposto à imagem: arrastar para mover, clicar
  num ponto médio para inserir vértice, botão direito para remover, ou
  desenhar um polígono manualmente do zero.

**Formatos de imagem aceitos:** JPG, PNG, WEBP, GIF, BMP e TIFF/GeoTIFF (até
40 MB e 60 megapixels). TIFF é decodificado inteiramente no navegador via
[geotiff.js](https://github.com/geotiffjs/geotiff.js) (carregado via CDN em
`index.html`) - nenhum arquivo passa por conversão no servidor. Qualquer
formato que a Anthropic não aceita diretamente (BMP, TIFF) é automaticamente
reconvertido para PNG no navegador antes do envio para análise; JPG, PNG,
WEBP e GIF são enviados como o arquivo original.

**Não requer nenhuma variável de ambiente nova** — reaproveita
`ANTHROPIC_API_KEY` / `CLAUDE_MODEL` já usadas por `api/analisar-documento.js`,
e o mesmo Blob Store.

**Limitações conhecidas (protótipo):**

- **Nada é persistido no projeto/Supabase.** O resultado existe só durante a
  sessão do navegador — é preciso exportar (GeoJSON/SVG/PNG) antes de trocar
  de imagem ou fechar a página. Persistência pode ser adicionada depois
  seguindo o mesmo padrão de `matriculaia_documentos`.
- O georreferenciamento por 2 pontos assume a ortofoto **orientada para o
  norte** (topo = norte) e é uma aproximação plana adequada à escala de
  lote/quadra — não substitui levantamento fotogramétrico/GNSS para fins de
  registro oficial. A interface exibe esse aviso e o marca em toda exportação
  GeoJSON.
- Muro/cerca físicos nem sempre coincidem com o limite legal do imóvel
  (invasões, recuos não regularizados, posse divergente do registro). A
  proposta da IA deve sempre ser conferida por profissional habilitado antes
  de qualquer uso oficial (desmembramento, georreferenciamento junto ao
  INCRA, protocolo em cartório).
- Uma imagem por vez; sem suporte a mosaico de múltiplas ortofotos.
- TIFF/GeoTIFF: só as 3 (ou 4) primeiras bandas são interpretadas como
  RGB(A) - imagens multiespectrais com mais bandas, ou TIFF com paleta de
  cores indexada, não são renderizadas corretamente. Se o TIFF tiver
  georreferenciamento embutido (comum em exports de Pix4D/DroneDeploy/QGIS),
  ele ainda **não** é lido automaticamente neste protótipo - a calibração de
  2 pontos continua manual mesmo para GeoTIFF (aproveitar o georreferenciamento
  embutido automaticamente é uma melhoria natural para uma próxima versão).
