# INTEGRAL GEO MATRÍCULA

Aplicação web para leitura de matrículas imobiliárias e memoriais descritivos
com IA (identificação/extração) + geoprocessamento determinístico (validação,
poligonal, área, perímetro). Desenvolvida para a **Integral Soluções em
Engenharia**.

> **Importante — divisão de responsabilidades**
> A IA (OpenAI) **só identifica e extrai** o que está escrito no documento.
> **Nenhuma linha de código de geoprocessamento (conversão de coordenadas,
> construção da poligonal, área, perímetro, validações) usa IA.** Essa parte é
> feita inteiramente em JavaScript determinístico, com Turf.js e Proj4js, no
> navegador (`lib/coordinates.js` e `lib/geometry.js`).

---

## 1. Estrutura do projeto

```
/
├── index.html                  Shell da aplicação (sidebar + 5 telas)
├── styles.css                  Identidade visual (GIS/SaaS corporativo)
├── app.js                      Orquestração do frontend
├── lib/
│   ├── coordinates.js          Parsing/conversão de coordenadas (Proj4js)
│   ├── geometry.js             Poligonal, área, perímetro, validações (Turf.js)
│   └── export.js               Geração de GeoJSON / KML / CSV / TXT
├── api/
│   └── analisar-documento.js   Serverless function: chama a OpenAI
├── package.json
├── vercel.json
├── .env.example
├── .gitignore
└── README.md
```

### Por que `lib/*.js` funcionam tanto no navegador quanto no backend?

Eles usam um pequeno padrão UMD (`if (module.exports) ... else window.X = ...`).
Na prática, hoje **apenas o navegador usa `lib/coordinates.js` e
`lib/geometry.js` e `lib/export.js`** (carregados como `<script>` em
`index.html`, junto com Leaflet, Turf.js e Proj4js via CDN). O backend
(`api/analisar-documento.js`) só faz uma coisa: montar a chamada para a
OpenAI e devolver o JSON de extração — ele não faz geoprocessamento, então
não precisa importar essas libs. O padrão UMD foi mantido para permitir, no
futuro, mover parte da validação para o servidor sem reescrever o código.

---

## 2. Como funciona (fluxo)

1. **Nova análise**: o usuário envia PDF/JPG/JPEG/PNG/WEBP (até 3 MB — veja
   a nota sobre limite de tamanho na seção 6).
2. O arquivo é convertido para Base64 no navegador e enviado via `POST` para
   `/api/analisar-documento`.
3. O backend chama a **OpenAI Responses API** (modelo com suporte a
   visão/PDF) com um prompt que proíbe explicitamente a IA de inventar
   qualquer dado (regra da seção 29 da especificação) e exige uma saída em
   **JSON Schema estrito**.
4. O JSON retornado é devolvido ao navegador. A partir daqui, **tudo é
   determinístico**:
   - `lib/coordinates.js` resolve cada vértice para `[lng, lat]` em WGS84
     (convertendo UTM→geográfica quando necessário via Proj4js, ou aplicando
     a cadeia de azimute/distância quando faltar coordenada absoluta);
   - `lib/geometry.js` constrói a poligonal (**respeitando a ordem
     documental**, nunca reordenando vértices), calcula área/perímetro
     (Turf.js) e roda as validações geométricas e espaciais;
   - o mapa (Leaflet), a tabela de vértices, o painel de validação e as
     exportações são todos gerados a partir desse resultado.
5. Qualquer edição manual na tabela de vértices dispara um novo cálculo
   completo (`recompute()`), e o vértice editado passa a ser marcado como
   **"EDITADO"** (vértices calculados por azimute/distância são marcados
   como **"CALCULADO"**, e os demais como **"EXTRAÍDO"**).

### Reconstrução por azimute/distância (seções 19 e 20)

- Se um vértice não tiver coordenada própria, mas o vértice anterior tiver
  coordenada resolvida **e** azimute/rumo + distância até o próximo vértice,
  o sistema calcula a posição do vértice seguinte por geodesia esférica
  (`Coords.destinationPoint`). Esses vértices ficam marcados como
  **CALCULADO**.
- Se **nenhum** vértice tiver coordenada absoluta, mas existir uma cadeia
  completa de azimute/rumo + distância, o sistema reconstrói apenas a
  **forma relativa** da poligonal (em um plano local, metros) para permitir
  calcular área/perímetro — mas **não desenha nada no mapa** e desabilita a
  exportação em GeoJSON/KML, exibindo um aviso claro. Isso evita posicionar
  a geometria arbitrariamente sobre o globo.

---

## 3. Limitações conhecidas (leia antes de usar em produção)

- **Conversão de datum**: os parâmetros de transformação Molodensky usados
  para SAD69, Córrego Alegre e Astro-Chuá em `lib/coordinates.js` são
  aproximações de uso comum em cartografia, **suficientes para
  visualização em mapa e cálculo de área/perímetro**, mas não substituem
  uma transformação geodésica oficial (ex.: PROGRID/IBGE) para fins de
  georreferenciamento certificado junto ao INCRA. Para SIRGAS2000/WGS84 a
  aproximação é mínima.
- **Limite de tamanho de arquivo**: as Vercel Serverless Functions (plano
  Hobby) aceitam corpos de requisição de até ~4,5 MB. Como o arquivo é
  enviado em Base64 (acréscimo de ~33%) dentro de um JSON, o limite do
  arquivo original ficou configurado em **3 MB** (`MAX_FILE_SIZE_BYTES`).
  Se você tiver plano Pro/Enterprise com limites maiores, ajuste essa
  variável — mas sempre deixando margem para o overhead do Base64 + JSON.
  Para documentos maiores, a alternativa correta é fazer upload direto para
  um storage (ex.: Vercel Blob) e passar uma URL à OpenAI — isso é uma
  mudança de arquitetura fora do escopo deste MVP.
- **Sem persistência**: nada é salvo em banco de dados ou disco. Se a
  página for recarregada, a análise se perde. Isso é intencional (requisito
  do projeto).

---

## 4. Rodando localmente

```bash
npm i -g vercel
vercel dev
```

Crie um arquivo `.env` (baseado em `.env.example`, **nunca commitado**) com:

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
MAX_FILE_SIZE_BYTES=3000000
```

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
