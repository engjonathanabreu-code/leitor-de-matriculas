# Ortofoto → divisão de lotes — versão OFFLINE

Esta pasta é uma aplicação **separada e independente** do site principal
(`leitor-de-matriculas`, hospedado na Vercel). Ela existe para resolver um
problema específico: **ortofotos reais costumam vir como GeoTIFF de
centenas de MB** (o arquivo de referência citado durante o desenvolvimento
tem 611 MB), e um navegador simplesmente não consegue abrir um arquivo
desse tamanho na aba "Ortofoto" do site — a página trava por falta de
memória bem antes de qualquer envio.

## Como funciona

Você roda um pequeno servidor **nesta própria máquina** (não precisa de
Vercel, Supabase, nem conexão com o site principal). Ele:

1. Lê o arquivo de ortofoto **direto do disco**, pelo caminho que você
   informa — o arquivo nunca é enviado por upload nem passa pela rede.
2. Usa a biblioteca `sharp` (baseada em `libvips`) para decodificar e
   reduzir a imagem **em streaming**, sem nunca carregar o arquivo inteiro
   de uma vez na memória. Isso é o que permite abrir um TIFF de 600+ MB sem
   travar, o que o navegador sozinho não consegue fazer.
3. Gera, localmente, uma cópia pequena (poucos MB) da imagem: uma versão
   para você **ver e editar** na tela, e uma versão **para a IA analisar**
   (menor, dentro dos limites de visão da Anthropic).
4. Envia **somente essa cópia pequena** para a API da Claude (Anthropic),
   pedindo para propor os polígonos dos lotes — usando exatamente o mesmo
   agente, prompt e regras de `api/analisar-ortofoto.js` (o módulo irmão
   deste, que roda no site hospedado).

A partir daí, a experiência é a mesma do protótipo do site: editor de
vértices (arrastar, inserir, remover, desenhar manualmente), calibração
geográfica por 2 pontos e exportação em GeoJSON/SVG/PNG — usando o mesmo
`lib/ortofoto.js` determinístico (área, geocalibração e exportação **nunca**
são calculadas pela IA, sempre por código determinístico rodando no seu
navegador).

**Nada sai desta máquina, exceto a cópia reduzida da imagem enviada à
Anthropic para a etapa de IA.** Não há Vercel Blob, não há Supabase, não há
login — é uma ferramenta de uso local, pontual, para arquivos grandes demais
para a aba web.

## Pré-requisitos

- [Node.js](https://nodejs.org) 18 ou mais recente instalado na máquina.
- Uma chave de API da Anthropic (`ANTHROPIC_API_KEY`) — a mesma variável
  usada pelo site hospedado, se você já tiver uma configurada lá em
  Project Settings da Vercel. **Aqui ela mora no seu computador, num
  arquivo `.env` local — nunca é enviada a lugar nenhum além da própria
  Anthropic.**

## Como rodar

```bash
cd offline-app
npm install
cp .env.example .env
```

Abra o `.env` recém-criado e preencha `ANTHROPIC_API_KEY=sk-ant-...` com sua
chave. Depois:

```bash
npm start
```

O terminal vai mostrar algo como:

```
Integral Geo Matricula - Ortofoto (offline)
-> http://127.0.0.1:5175
```

Abra esse endereço no navegador (Chrome, Edge, Firefox — qualquer um). O
servidor só escuta em `127.0.0.1` (a própria máquina) — mais ninguém na sua
rede consegue acessá-lo.

## Usando

1. **Selecionar ortofoto**: cole o caminho completo do arquivo no campo de
   texto (ex: `/home/usuario/Downloads/ortomosaico.tif` no Linux/Mac, ou
   `C:\Users\usuario\Downloads\ortomosaico.tif` no Windows), ou clique em
   "Procurar…" para navegar pelas pastas do computador. Clique em
   "Carregar" — isso só decodifica/reduz a imagem localmente, sem gastar
   nenhuma chamada de IA.
2. **Detectar divisas com IA**: clique no botão para enviar a cópia
   reduzida à Claude e receber os polígonos propostos. Pode levar de alguns
   segundos a cerca de um minuto, dependendo do tamanho do arquivo original
   (a parte demorada é a leitura/redução local, não a chamada de IA em si).
3. Edite livremente: arraste vértices, clique num ponto médio de uma aresta
   para inserir um vértice novo, botão direito num vértice para removê-lo,
   ou "+ Novo polígono manual" para desenhar do zero.
4. (Opcional) Marque 2 pontos de coordenada conhecida (latitude/longitude)
   para ativar área em m² e exportação georreferenciada.
5. Exporte em GeoJSON, SVG ou PNG antes de trocar de imagem — **nada é
   salvo automaticamente**; fechar a aba ou trocar de arquivo descarta o
   trabalho não exportado.

## Formatos aceitos

JPG, PNG, WEBP, GIF, BMP e TIFF/GeoTIFF — sem limite de tamanho de arquivo
imposto por esta aplicação (o limite real passa a ser a paciência para
esperar a leitura de um arquivo muito grande, e o espaço em disco/memória
disponíveis na sua máquina, não mais os limites do navegador).

## Limitações conhecidas

- **TIFF exóticos**: a biblioteca usada aqui (`sharp`/`libvips`) lê a
  imensa maioria dos GeoTIFFs de ortomosaico (RGB/RGBA, 8 bits, compressão
  LZW/Deflate/JPEG-in-TIFF), mas pode falhar em variantes raras
  (multiespectral com muitas bandas, paleta de cores indexada, BigTIFF
  acima de 4 GB). Se acontecer, a mensagem de erro sugere reexportar o
  arquivo em outro formato/compressão no software de origem (Pix4D,
  DroneDeploy, QGIS).
- **Georreferenciamento embutido no TIFF não é lido automaticamente** —
  mesma limitação (e mesmo motivo) documentada no protótipo do site: a
  calibração de 2 pontos continua manual. Ler o georreferenciamento
  embutido automaticamente é uma melhoria natural para uma próxima versão.
- **Nada é persistido** — sem projeto, sem Supabase, sem histórico. É uma
  ferramenta de uso pontual; exporte antes de fechar.
- Uma imagem por vez; sem suporte a mosaico de múltiplas ortofotos.
- Assim como no protótipo do site, muro/cerca físicos nem sempre coincidem
  com o limite legal do imóvel — a proposta da IA deve sempre ser conferida
  por profissional habilitado antes de qualquer uso oficial.

## Relação com o site hospedado (`leitor-de-matriculas`)

Esta aplicação é um complemento, não uma substituição: para ortofotos que
já cabem nos limites do navegador (até ~40 MB), a aba "Ortofoto" do site
continua sendo mais prática (não exige instalar nada). Esta versão offline
existe especificamente para os casos de arquivo grande demais para o
navegador. O formato de saída (GeoJSON) é o mesmo dos dois lados, então o
resultado de uma pode ser conferido/reaberto em qualquer ferramenta GIS
(QGIS, por exemplo) independentemente de onde foi gerado.
