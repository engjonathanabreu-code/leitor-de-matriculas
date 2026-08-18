
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
