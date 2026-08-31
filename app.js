/**
 * app.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA - orquestracao do frontend.
 *
 * MODELO DE DADOS (v2 - projetos):
 *   - Um PROJETO agrupa varias matriculas relacionadas (documentos).
 *   - Cada DOCUMENTO e uma matricula/memorial ja analisado, com sua propria
 *     cor no mapa, vertices, geometria calculada e validacoes.
 *   - Projetos sao persistidos no banco de dados (Supabase), associados ao
 *     usuario logado - sincronizados entre qualquer dispositivo onde a
 *     mesma conta fizer login. O localStorage so guarda qual projeto estava
 *     ativo por ultimo (conveniencia local, nao e dado critico).
 *
 * Fluxo por documento:
 *   1. Upload direto ao Vercel Blob (api/blob-upload.js)
 *   2. POST da URL do Blob para /api/analisar-documento
 *   3. Backend chama o Claude (Anthropic) e devolve JSON com os dados
 *      IDENTIFICADOS (a IA nunca calcula geometria nem converte coordenadas).
 *   4. Tudo dali em diante e deterministico: resolucao de coordenadas,
 *      poligonal, area, perimetro e validacoes (lib/coordinates.js e
 *      lib/geometry.js). Qualquer edicao manual recalcula tudo de novo.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  // O arquivo vai direto para o Vercel Blob (api/blob-upload.js), nunca pelo
  // corpo de uma Serverless Function - por isso o limite pode ser bem maior
  // que os 4.5 MB de corpo de requisicao da Vercel. Mantenha este valor
  // igual ao MAX_FILE_SIZE_BYTES usado em api/blob-upload.js.
  var MAX_FILE_BYTES = 20 * 1000 * 1000; // 20 MB
  var ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];

  var PROGRESS_STEPS = [
    "Documento enviado",
    "Lendo documento",
    "Identificando sistema de coordenadas",
    "Extraindo vertices",
    "Validando coordenadas",
    "Construindo poligonal",
    "Calculando geometria",
    "Analise concluida"
  ];

  var COLOR_PALETTE = [
    "#1d4ed8", "#0d9488", "#b7791f", "#c0362c", "#7c3aed",
    "#0891b2", "#65a30d", "#db2777", "#ea580c", "#4338ca"
  ];

  var PROJECTS_KEY = "integral-geo-matricula:projetos"; // chave legada (versoes antigas, so localStorage) - usada so para migracao automatica
  var ACTIVE_PROJECT_KEY = "integral-geo-matricula:projeto-ativo";
  var MIGRACAO_FEITA_KEY = "integral-geo-matricula:migracao-servidor-feita";

  /** Estado global da aplicacao (unica fonte de verdade). */
  var state = {
    projetos: [], // [{ id, nome, criadoEm, atualizadoEm, documentos: [...] }]
    projetoAtivoId: null,
    documentoSelecionadoId: null, // qual documento do projeto ativo esta "em foco"
    formSistemaManualDocId: null, // id do documento com o formulario de sistema manual aberto (ou null)
    filaUpload: [], // [{ id, file, status: 'pendente'|'processando'|'ok'|'erro', erro }]
    processandoFila: false,
    map: null,
    mapBaseLayers: { mapa: null, satelite: null },
    mapLayers: {} // { [documentoId]: { polygon, vertices, _oculta } }
  };

  // ==========================================================================
  // PERSISTENCIA DE PROJETOS - Supabase (sincronizado entre dispositivos)
  // Cada usuario ve os mesmos projetos/matriculas em qualquer computador
  // onde fizer login - os dados moram no banco, protegidos por RLS (cada
  // um so acessa os proprios). O localStorage so guarda qual projeto estava
  // ativo por ultimo, como conveniencia (nao e dado critico).
  // ==========================================================================
  function sb() { return window.supabaseClient; }

  async function carregarProjetosDoServidor() {
    var client = sb();
    var { data: projetosRows, error: erroProjetos } = await client
      .from("matriculaia_projetos")
      .select("*")
      .order("atualizado_em", { ascending: false });

    if (erroProjetos) {
      console.error("[sync] falha ao carregar projetos:", erroProjetos.message);
      return [];
    }

    var { data: documentosRows, error: erroDocs } = await client.from("matriculaia_documentos").select("*");
    if (erroDocs) console.error("[sync] falha ao carregar documentos:", erroDocs.message);

    var docsPorProjeto = {};
    (documentosRows || []).forEach(function (row) {
      var doc = row.dados || {};
      doc.id = row.id;
      doc.nomeArquivo = row.nome_arquivo;
      doc.cor = row.cor;
      doc.dataAnalise = row.data_analise;
      if (!docsPorProjeto[row.projeto_id]) docsPorProjeto[row.projeto_id] = [];
      docsPorProjeto[row.projeto_id].push(doc);
    });

    return (projetosRows || []).map(function (p) {
      var docs = (docsPorProjeto[p.id] || []).sort(function (a, b) {
        return new Date(a.dataAnalise) - new Date(b.dataAnalise);
      });
      return {
        id: p.id, nome: p.nome, criadoEm: p.criado_em, atualizadoEm: p.atualizado_em,
        userId: p.user_id, donoEmail: p.dono_email, donoNome: p.dono_nome,
        documentos: docs
      };
    });
  }

  async function criarProjetoNoServidor(id, nome) {
    var client = sb();
    var userResp = await client.auth.getUser();
    var user = userResp.data && userResp.data.user ? userResp.data.user : null;
    if (!user) return;
    var { error } = await client.from("matriculaia_projetos").insert({
      id: id,
      user_id: user.id,
      nome: nome,
      dono_email: user.email,
      dono_nome: (window.__auth && window.__auth.getNomeUsuario()) || null
    });
    if (error) console.error("[sync] falha ao criar projeto:", error.message);
  }

  async function renomearProjetoNoServidor(id, nome) {
    var { error } = await sb().from("matriculaia_projetos").update({ nome: nome, atualizado_em: new Date().toISOString() }).eq("id", id);
    if (error) console.error("[sync] falha ao renomear projeto:", error.message);
  }

  async function tocarProjetoNoServidor(id) {
    var { error } = await sb().from("matriculaia_projetos").update({ atualizado_em: new Date().toISOString() }).eq("id", id);
    if (error) console.error("[sync] falha ao atualizar projeto:", error.message);
  }

  async function excluirProjetoNoServidor(id) {
    var { error } = await sb().from("matriculaia_projetos").delete().eq("id", id);
    if (error) console.error("[sync] falha ao excluir projeto:", error.message);
  }

  async function salvarDocumentoNoServidorAsync(projetoId, doc) {
    var dados = {};
    for (var k in doc) {
      if (k === "id" || k === "nomeArquivo" || k === "cor" || k === "dataAnalise") continue;
      dados[k] = doc[k];
    }
    var { error } = await sb().from("matriculaia_documentos").upsert({
      id: doc.id,
      projeto_id: projetoId,
      nome_arquivo: doc.nomeArquivo,
      cor: doc.cor,
      data_analise: doc.dataAnalise,
      dados: dados
    });
    if (error) console.error("[sync] falha ao salvar documento:", error.message);
  }

  async function excluirDocumentoNoServidor(id) {
    var { error } = await sb().from("matriculaia_documentos").delete().eq("id", id);
    if (error) console.error("[sync] falha ao excluir documento:", error.message);
  }

  /**
   * Salva um documento editado no servidor SEM bloquear a interface (a tela ja
   * foi atualizada localmente antes desta chamada). Tambem toca o projeto para
   * refletir a data de ultima atualizacao.
   */
  function salvarDocumentoAtualizado(doc) {
    var project = getActiveProject();
    if (!project) return;
    project.atualizadoEm = new Date().toISOString();
    salvarDocumentoNoServidorAsync(project.id, doc).catch(function (e) {
      console.error("[sync] erro inesperado ao salvar documento:", e);
    });
    tocarProjetoNoServidor(project.id).catch(function () {});
  }

  function getActiveProject() {
    return state.projetos.filter(function (p) { return p.id === state.projetoAtivoId; })[0] || null;
  }

  function getSelectedDocument() {
    var project = getActiveProject();
    if (!project || !project.documentos.length) return null;
    var found = project.documentos.filter(function (d) { return d.id === state.documentoSelecionadoId; })[0];
    return found || project.documentos[project.documentos.length - 1];
  }

  function createProject(nome) {
    var project = {
      id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      nome: nome,
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
      documentos: []
    };
    state.projetos.unshift(project);
    state.projetoAtivoId = project.id;
    state.documentoSelecionadoId = null;
    try { window.localStorage.setItem(ACTIVE_PROJECT_KEY, project.id); } catch (e) {}
    criarProjetoNoServidor(project.id, project.nome).catch(function (e) {
      console.error("[sync] erro inesperado ao criar projeto:", e);
    });
    populateProjectSelect();
    return project;
  }

  function switchProject(id) {
    state.projetoAtivoId = id;
    var project = getActiveProject();
    state.documentoSelecionadoId = project && project.documentos.length
      ? project.documentos[project.documentos.length - 1].id
      : null;
    try { window.localStorage.setItem(ACTIVE_PROJECT_KEY, id || ""); } catch (e) {}
    populateProjectSelect();
  }

  /** Garante que existe um projeto ativo, criando um (com nome pedido ao usuario) se necessario. */
  function ensureActiveProject() {
    var project = getActiveProject();
    if (project) return project;
    var sugestao = "Projeto " + new Date().toLocaleDateString("pt-BR");
    var nome = window.prompt("Nome do projeto para esta(s) analise(s):", sugestao);
    if (!nome) return null;
    var p = createProject(nome.trim() || sugestao);
    renderProjetos();
    return p;
  }

  function nextColor(project) {
    return COLOR_PALETTE[project.documentos.length % COLOR_PALETTE.length];
  }

  function populateProjectSelect() {
    var sel = document.getElementById("seletor-projeto");
    var html = "";
    if (!state.projetos.length) {
      html = '<option value="">Nenhum projeto</option>';
    } else {
      state.projetos.forEach(function (p) {
        html += '<option value="' + p.id + '"' + (p.id === state.projetoAtivoId ? " selected" : "") + '>' +
          esc(p.nome) + " (" + p.documentos.length + ")</option>";
      });
    }
    html += '<option value="__novo__">+ Novo projeto...</option>';
    sel.innerHTML = html;
  }

  // ==========================================================================
  // NAVEGACAO
  // ==========================================================================
  function initNav() {
    var items = document.querySelectorAll(".nav-item");
    items.forEach(function (btn) {
      btn.addEventListener("click", function () {
        items.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
        var view = document.getElementById("view-" + btn.dataset.view);
        if (view) view.classList.add("active");

        if (btn.dataset.view === "mapa") {
          renderMap();
          if (state.map) setTimeout(function () { state.map.invalidateSize(); }, 50);
        }
        if (btn.dataset.view === "dados-extraidos") renderDadosExtraidos();
        if (btn.dataset.view === "validacao") renderValidacao();
        if (btn.dataset.view === "exportacao") renderExportacao();
        if (btn.dataset.view === "projetos") renderProjetos();
        if (btn.dataset.view === "usuarios" && window.__auth) window.__auth.renderUsuarios();
      });
    });
  }

  function goToView(name) {
    var btn = document.querySelector('.nav-item[data-view="' + name + '"]');
    if (btn) btn.click();
  }

  // ==========================================================================
  // UPLOAD (multiplos arquivos, fila)
  // ==========================================================================
  function initUpload() {
    var dropzone = document.getElementById("dropzone");
    var fileInput = document.getElementById("file-input");
    var btnSelecionar = document.getElementById("btn-selecionar");
    var btnAnalisar = document.getElementById("btn-analisar");

    btnSelecionar.addEventListener("click", function () { fileInput.click(); });

    ["dragenter", "dragover"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        dropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        dropzone.classList.remove("dragover");
      });
    });
    dropzone.addEventListener("drop", function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFilesSelected(e.dataTransfer.files);
      }
    });

    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files.length) handleFilesSelected(fileInput.files);
      fileInput.value = ""; // permite selecionar os mesmos arquivos de novo depois
    });

    btnAnalisar.addEventListener("click", processFila);
  }

  function hideUploadError() {
    var el = document.getElementById("upload-error");
    el.hidden = true;
    el.textContent = "";
  }

  function showUploadError(msg) {
    var el = document.getElementById("upload-error");
    el.hidden = false;
    el.textContent = msg;
  }

  var MAX_ARQUIVOS_POR_LOTE = 10;

  function handleFilesSelected(fileList) {
    hideUploadError();
    var erros = [];
    var jaNaFila = state.filaUpload.length;

    Array.prototype.forEach.call(fileList, function (file) {
      if (jaNaFila >= MAX_ARQUIVOS_POR_LOTE) {
        erros.push(file.name + ": limite de " + MAX_ARQUIVOS_POR_LOTE + " documentos por lote atingido, nao adicionado.");
        return;
      }
      var ext = file.name.split(".").pop().toLowerCase();
      var typeOk =
        ALLOWED_TYPES.indexOf(file.type) !== -1 ||
        ["pdf", "jpg", "jpeg", "png", "webp"].indexOf(ext) !== -1;
      if (!typeOk) {
        erros.push(file.name + ": formato nao suportado.");
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        erros.push(file.name + ": maior que " + (MAX_FILE_BYTES / 1000000).toFixed(1) + " MB.");
        return;
      }
      state.filaUpload.push({
        id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        file: file,
        status: "pendente",
        erro: null
      });
      jaNaFila++;
    });
    if (erros.length) showUploadError(erros.join(" "));
    renderFilaArquivos();
  }

  var FILA_STATUS_LABEL = { pendente: "Pendente", processando: "Processando...", ok: "Concluido", erro: "Erro" };

  function renderFilaArquivos() {
    var wrap = document.getElementById("fila-arquivos");
    var lista = document.getElementById("fila-arquivos-lista");
    var btnAnalisar = document.getElementById("btn-analisar");

    if (!state.filaUpload.length) {
      wrap.hidden = true;
      btnAnalisar.disabled = true;
      return;
    }
    wrap.hidden = false;

    lista.innerHTML = state.filaUpload.map(function (item) {
      return (
        '<div class="fila-item">' +
        '<div class="fila-item-info"><div>' +
        '<div class="fila-item-name">' + esc(item.file.name) + "</div>" +
        '<div class="fila-item-meta">' + (item.file.size / 1000).toFixed(0) + " KB" +
        (item.erro ? " · " + esc(item.erro) : "") +
        "</div>" +
        "</div></div>" +
        '<span class="fila-item-status fila-item-status--' + item.status + '">' + FILA_STATUS_LABEL[item.status] + "</span>" +
        (item.status === "pendente"
          ? '<button class="row-delete" data-remove-fila="' + item.id + '" title="Remover">✕</button>'
          : "") +
        "</div>"
      );
    }).join("");

    lista.querySelectorAll("[data-remove-fila]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.filaUpload = state.filaUpload.filter(function (i) { return i.id !== btn.dataset.removeFila; });
        renderFilaArquivos();
      });
    });

    btnAnalisar.disabled = state.processandoFila || !state.filaUpload.some(function (i) { return i.status === "pendente"; });
  }

  // ==========================================================================
  // UPLOAD PARA O VERCEL BLOB (bypass do limite de 4.5MB das Functions)
  // ==========================================================================
  // A biblioteca @vercel/blob/client vem de lib/vendor/vercel-blob-client.bundle.js
  // (empacotada previamente com esbuild), carregada via <script> comum no
  // index.html. Isso evita depender de um CDN externo (esm.sh) em tempo de
  // execucao para empacotar um pacote pensado para Node.js sob demanda no
  // navegador - abordagem que se mostrou instavel (upload travava
  // silenciosamente, sem erro, em vez de falhar rapido).
  async function uploadToBlob(file, onProgress) {
    if (!window.VercelBlobClient || typeof window.VercelBlobClient.upload !== "function") {
      throw new Error(
        "Biblioteca de upload nao carregou (lib/vendor/vercel-blob-client.bundle.js). Verifique se o arquivo foi enviado ao GitHub e se o script esta referenciado no index.html."
      );
    }
    var blob = await window.VercelBlobClient.upload(file.name, file, {
      access: "public",
      handleUploadUrl: "/api/blob-upload",
      onUploadProgress: onProgress
    });
    return blob.url;
  }

  function guessMimeFromName(name) {
    var ext = name.split(".").pop().toLowerCase();
    var map = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    return map[ext] || "application/octet-stream";
  }

  // ==========================================================================
  // PROGRESSO VISUAL (secao 31)
  // ==========================================================================
  function renderProgressSteps(activeIndex, doneUpTo, errorIndex) {
    var list = document.getElementById("progress-steps");
    list.innerHTML = "";
    PROGRESS_STEPS.forEach(function (label, i) {
      var li = document.createElement("li");
      var cls = "";
      var dotContent = "";
      if (errorIndex != null && i === errorIndex) {
        cls = "error";
        dotContent = "✕";
      } else if (i <= doneUpTo) {
        cls = "done";
        dotContent = "✓";
      } else if (i === activeIndex) {
        cls = "active";
      }
      li.className = cls;
      li.innerHTML = '<span class="dot">' + dotContent + "</span><span>" + label + "</span>";
      list.appendChild(li);
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** Garante que uma Promise nunca fica pendurada para sempre - rejeita com mensagem clara apos o prazo. */
  function withTimeout(promise, ms, message) {
    var timeoutId;
    var timeout = new Promise(function (_, reject) {
      timeoutId = setTimeout(function () { reject(new Error(message)); }, ms);
    });
    return Promise.race([promise, timeout]).finally(function () { clearTimeout(timeoutId); });
  }

  function setStatusPill(kind, text) {
    var el = document.getElementById("status-pill");
    el.className = "status-pill status-pill--" + kind;
    el.textContent = text;
  }

  // ==========================================================================
  // ANALISE (fila -> um documento por vez -> adicionado ao projeto ativo)
  // ==========================================================================
  async function processFila() {
    if (state.processandoFila) return;
    var pendentes = state.filaUpload.filter(function (i) { return i.status === "pendente"; });
    if (!pendentes.length) return;

    var project = ensureActiveProject();
    if (!project) return; // usuario cancelou a criacao do projeto

    var meuUserId = window.__auth ? window.__auth.getUserId() : null;
    if (project.userId && meuUserId && project.userId !== meuUserId) {
      showUploadError(
        'Este projeto ("' + project.nome + '") pertence a outro usuario - voce so pode visualiza-lo. ' +
        "Crie ou ative um projeto seu na aba Projetos para analisar novos documentos."
      );
      return;
    }

    state.processandoFila = true;
    document.getElementById("btn-analisar").disabled = true;
    document.getElementById("progress-card").hidden = false;
    document.getElementById("result-summary").hidden = true;
    hideUploadError();

    for (var i = 0; i < pendentes.length; i++) {
      var item = pendentes[i];
      item.status = "processando";
      renderFilaArquivos();
      document.getElementById("progress-titulo").textContent =
        "Processando " + (i + 1) + " de " + pendentes.length + ": " + item.file.name;
      setStatusPill("processing", "Analisando " + (i + 1) + "/" + pendentes.length + "...");
      renderProgressSteps(0, -1, null);

      try {
        var doc = await analisarUmArquivo(item.file, project);
        item.status = "ok";
        state.documentoSelecionadoId = doc.id;
        renderResultSummaryFor(doc);
        document.getElementById("result-summary").hidden = false;
      } catch (err) {
        item.status = "erro";
        item.erro = (err && err.message) || "Falha ao analisar.";
        renderProgressSteps(null, 0, 1);
      }
      renderFilaArquivos();
    }

    state.processandoFila = false;
    // remove da fila os que deram certo; mantem os com erro para o usuario tentar de novo ou remover
    state.filaUpload = state.filaUpload.filter(function (i) { return i.status !== "ok"; });
    renderFilaArquivos();

    var houveErro = state.filaUpload.some(function (i) { return i.status === "erro"; });
    if (houveErro) {
      setStatusPill("error", "Concluido com erros");
      showUploadError("Alguns documentos nao puderam ser analisados. Veja os detalhes na lista acima.");
    } else {
      setStatusPill("ok", "Analise concluida");
    }

    renderAllForActiveProject();
    renderProjetos();
  }

  /** Analisa UM arquivo e devolve o "documento" ja adicionado ao projeto. Lanca erro em caso de falha. */
  async function analisarUmArquivo(file, project) {
    var blobUrl = await withTimeout(
      uploadToBlob(file, function (progress) {
        setStatusPill("processing", "Enviando " + file.name + "... " + Math.round(progress.percentage) + "%");
      }),
      120000,
      "O envio do arquivo demorou demais e foi cancelado (mais de 2 minutos). Verifique sua conexao e tente novamente."
    );

    renderProgressSteps(1, 0, null);

    var resp = await withTimeout(
      fetch("/api/analisar-documento", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + (window.__auth ? window.__auth.getAccessToken() : "")
        },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || guessMimeFromName(file.name),
          blobUrl: blobUrl
        })
      }),
      290000,
      "A analise demorou demais e foi cancelada (mais de 4:50min). O documento pode ser muito grande ou complexo; tente novamente."
    );

    var json = await resp.json();
    if (!resp.ok || !json.sucesso) {
      throw new Error((json && json.erro) || "Falha ao analisar o documento.");
    }

    renderProgressSteps(3, 2, null);
    await sleep(120);

    var doc = buildDocumentoFromExtraction(json.dados, file.name);
    doc.cor = nextColor(project);

    renderProgressSteps(4, 3, null);
    await sleep(100);
    renderProgressSteps(5, 4, null);
    await sleep(100);

    computeDocumento(doc);

    renderProgressSteps(6, 5, null);
    await sleep(90);
    renderProgressSteps(7, 6, null);
    await sleep(90);
    renderProgressSteps(8, 8, null);

    project.documentos.push(doc);
    project.atualizadoEm = new Date().toISOString();
    await salvarDocumentoNoServidorAsync(project.id, doc);
    tocarProjetoNoServidor(project.id).catch(function () {});

    return doc;
  }

  /**
   * Normaliza o JSON retornado pela IA para um objeto "documento" de trabalho.
   *
   * IMPORTANTE: a IA nunca envia latitude/longitude como grau decimal
   * pronto - ela transcreve o texto literal (latitude_texto/longitude_texto),
   * exatamente como impresso no documento (GMS ou decimal). A conversao
   * para grau decimal e feita AQUI, deterministicamente, por
   * IntegralCoordinates.parseDMSToDecimal - nunca pela IA.
   */
  /**
   * Rede de seguranca deterministica: se, apesar da instrucao no prompt, a IA
   * ainda assim criar um vertice extra so para representar o fechamento do
   * poligono (repetindo a mesma coordenada do primeiro vertice, ou com um id
   * como "M1_fechamento"), remove esse vertice. O fechamento e sempre
   * implicito (ultimo vertice -> primeiro vertice); um vertice duplicado
   * quebra a reconstrucao por azimute/distancia sem motivo.
   */
  function removerVerticeFechamentoDuplicado(vertices) {
    if (!vertices || vertices.length < 4) return vertices;
    var first = vertices[0];
    var last = vertices[vertices.length - 1];

    var mesmoPontoUTM =
      first.easting != null && last.easting != null &&
      Math.abs(first.easting - last.easting) < 0.05 &&
      Math.abs(first.northing - last.northing) < 0.05;

    var mesmoPontoGeo =
      first.latitude != null && last.latitude != null &&
      Math.abs(first.latitude - last.latitude) < 1e-7 &&
      Math.abs(first.longitude - last.longitude) < 1e-7;

    var idSugereFechamento = /fecham|retorno|fecho|closing/i.test(String(last.id || ""));

    if (mesmoPontoUTM || mesmoPontoGeo || idSugereFechamento) {
      return vertices.slice(0, -1);
    }
    return vertices;
  }

  /** Remove acentos, caixa e pontuacao para comparar nomes de confrontantes com seguranca. */
  function normalizarTextoConfrontante(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "")
      .replace(/0+(\d)/g, "$1"); // "Lote 08" e "Lote 8" devem ser tratados como o mesmo confrontante
  }

  /**
   * Completa vertice_inicial/vertice_final/distancia/azimute da lista de
   * confrontantes cruzando deterministicamente com os dados por vertice
   * (confrontante_para_proximo/distancia_para_proximo/azimute_para_proximo),
   * que ja vem confiavelmente preenchidos pela extracao por vertice. Isso
   * evita depender da IA fazer esse cruzamento sozinha (instavel - as vezes
   * preenche uma linha e deixa as outras em branco, mesmo doc, doc a doc).
   * Quando um confrontante aparece em mais de um segmento (varios vertices
   * confrontando com o mesmo lote), soma as distancias e lista os vertices.
   */
  function completarConfrontantesComVertices(confrontantes, vertices) {
    return confrontantes.map(function (c) {
      var chave = normalizarTextoConfrontante(c.nome);
      if (!chave) return c;

      var inicial = null, distanciaTotal = 0, temDistancia = false, primeiroAzimute = null;
      for (var i = 0; i < vertices.length; i++) {
        var v = vertices[i];
        if (normalizarTextoConfrontante(v.confrontante_para_proximo) !== chave) continue;
        if (inicial == null) inicial = v.id;
        if (v.distancia_para_proximo != null) {
          distanciaTotal += Number(v.distancia_para_proximo);
          temDistancia = true;
        }
        if (primeiroAzimute == null) primeiroAzimute = v.azimute_para_proximo || v.rumo_para_proximo;
      }

      if (inicial == null) return c; // nenhum vertice bate com esse confrontante - deixa como veio

      var proximoIdx = vertices.findIndex(function (v) { return v.id === inicial; });
      var final = vertices[(proximoIdx + 1) % vertices.length].id;

      return Object.assign({}, c, {
        vertice_inicial: c.vertice_inicial || inicial,
        vertice_final: c.vertice_final || final,
        distancia: c.distancia != null ? c.distancia : (temDistancia ? distanciaTotal : null),
        azimute: c.azimute || primeiroAzimute
      });
    });
  }

  function buildDocumentoFromExtraction(dados, nomeArquivo) {
    var vertices = (dados.vertices || []).map(function (v) {
      var lat = v.latitude_texto ? IntegralCoordinates.parseDMSToDecimal(v.latitude_texto) : null;
      var lon = v.longitude_texto ? IntegralCoordinates.parseDMSToDecimal(v.longitude_texto) : null;
      return {
        id: v.id,
        origem: "EXTRAIDO",
        latitude: lat,
        longitude: lon,
        latitude_texto: v.latitude_texto || null,
        longitude_texto: v.longitude_texto || null,
        easting: v.easting,
        northing: v.northing,
        distancia_para_proximo: v.distancia_para_proximo,
        azimute_para_proximo: v.azimute_para_proximo,
        rumo_para_proximo: v.rumo_para_proximo,
        confrontante_para_proximo: v.confrontante_para_proximo,
        texto_origem: v.texto_origem,
        confianca: v.confianca != null ? v.confianca : 0
      };
    });

    vertices = removerVerticeFechamentoDuplicado(vertices);

    var confrontantes = completarConfrontantesComVertices(dados.confrontantes || [], vertices);

    var doc = {
      id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      nomeArquivo: nomeArquivo,
      dataAnalise: new Date().toISOString(),
      cor: null,
      extraido: dados,
      sistema: dados.sistema_coordenadas || { tipo: null, datum: null, epsg: null, zona: null, hemisferio: null, meridiano_central: null },
      vertices: vertices,
      confrontantes: confrontantes,
      alertasIA: dados.alertas || [],
      situacaoMatricula: dados.situacao_matricula || { ativa: null, substituida_por: null, texto_origem: null },
      sistemaManualCampos: { datum: false, zona: false, hemisferio: false }, // marca o que o usuario preencheu manualmente (nao veio do documento)
      matriculasCitadas: dados.matriculas_citadas || [],
      // sugestao da IA (conhecimento geral, NAO extraido do documento) - so usada para
      // pre-preencher o formulario manual; nunca aplicada a sistema sem confirmacao do usuario
      sugestaoGeografica: dados.sugestao_geografica || null,
      historicoRegistro: dados.historico_registro || [],
      // campos computados por computeDocumento():
      coordsLngLat: [],
      resolvedIndexes: [],
      missingIndexes: [],
      semPosicionamentoAbsoluto: false,
      relativeCoordsLngLat: null,
      polygonFeature: null,
      areaCalculada: null,
      perimetroCalculado: null,
      validacoes: []
    };

    resolveSistemaCoordenadas(doc);
    return doc;
  }

  // Estados brasileiros cuja area cruza ou toca a Linha do Equador - para estes,
  // NAO da pra assumir hemisferio Sul com seguranca quando o documento nao o informa.
  var UF_HEMISFERIO_INDETERMINADO = ["AP", "PA", "AM", "RR"];

  // Apenas 4 estados brasileiros cabem inteiramente dentro de uma unica zona UTM
  // (fato geografico verificavel, nao suposicao - fonte: IBGE/literatura de
  // geodesia). Todos os demais estados sao maiores que 6 graus de longitude e
  // cruzam mais de uma zona, entao NAO entram nesta tabela (ficam para
  // preenchimento manual quando o documento nao informar a zona).
  var UF_ZONA_UNICA = {
    SC: 22, // Santa Catarina
    ES: 24, // Espirito Santo
    SE: 24, // Sergipe
    CE: 24  // Ceara
  };

  /**
   * Preenche lacunas de sistema_coordenadas com conversoes puramente
   * matematicas/geograficas (NUNCA "adivinhacoes") a partir de dados que o
   * proprio documento ja declara:
   *  - Se o documento cita o Meridiano Central (comum em levantamentos mais
   *    antigos, em vez de "Fuso/Zona X") a zona UTM e uma decorrencia direta
   *    da formula: zona = (183 - meridiano_central_oeste) / 6.
   *  - Se a zona ainda nao foi determinada, mas o estado do imovel e um dos 4
   *    que cabem inteiros numa unica zona UTM (SC, ES, SE, CE), usa-se essa
   *    zona - de novo, fato geografico verificavel, nao suposicao.
   *  - Se o hemisferio nao e citado, mas o estado do imovel esta inteiramente
   *    ao sul da Linha do Equador (fato geografico, nao suposicao), assume-se
   *    hemisferio Sul.
   * Qualquer valor preenchido aqui gera um alerta visivel, nunca fica silencioso.
   */
  function resolveSistemaCoordenadas(doc) {
    var sc = doc.sistema;
    if (!sc || sc.tipo !== "UTM") return;
    doc.alertasIA = doc.alertasIA || [];

    if (sc.zona == null && sc.meridiano_central != null && sc.meridiano_central !== "") {
      var cm = Math.abs(parseFloat(String(sc.meridiano_central).replace(",", ".")));
      if (!isNaN(cm)) {
        var zonaCalculada = Math.round((183 - cm) / 6);
        if (zonaCalculada >= 1 && zonaCalculada <= 60) {
          sc.zona = zonaCalculada;
          doc.alertasIA.push(
            "Zona UTM " + zonaCalculada + " calculada a partir do Meridiano Central " + sc.meridiano_central +
            " citado no documento (conversao matematica direta, nao e uma suposicao)."
          );
        }
      }
    }

    if (sc.zona == null) {
      var estadoZona = doc.extraido && doc.extraido.matricula ? doc.extraido.matricula.estado : null;
      var ufZona = estadoZona ? String(estadoZona).trim().toUpperCase() : "";
      if (UF_ZONA_UNICA[ufZona] != null) {
        sc.zona = UF_ZONA_UNICA[ufZona];
        doc.alertasIA.push(
          "Zona UTM " + sc.zona + " determinada a partir do estado (" + ufZona + ") citado no documento - " +
          "esse estado esta inteiramente dentro dessa zona (fato geografico, nao e uma suposicao)."
        );
      }
    }

    if (sc.hemisferio == null) {
      var estado = doc.extraido && doc.extraido.matricula ? doc.extraido.matricula.estado : null;
      var uf = estado ? String(estado).trim().toUpperCase() : "";
      if (uf.length === 2 && UF_HEMISFERIO_INDETERMINADO.indexOf(uf) === -1) {
        sc.hemisferio = "S";
        doc.alertasIA.push(
          "Hemisferio Sul assumido para o estado " + uf + " (nao explicitado no documento). Todo o territorio deste estado esta ao sul da Linha do Equador."
        );
      }
    }
  }

  // ==========================================================================
  // PIPELINE GEOESPACIAL DETERMINISTICO, POR DOCUMENTO (nenhuma linha usa IA)
  // ==========================================================================
  function segmentAzimuth(vertex) {
    if (vertex.azimute_para_proximo) {
      var az = IntegralCoordinates.parseDMSToDecimal(vertex.azimute_para_proximo);
      if (az != null) return ((az % 360) + 360) % 360;
    }
    if (vertex.rumo_para_proximo) {
      var az2 = IntegralCoordinates.rumoToAzimuth(vertex.rumo_para_proximo);
      if (az2 != null) return az2;
    }
    return null;
  }

  function reconstructGeometryForDoc(doc) {
    var vertices = doc.vertices;
    var n = vertices.length;
    var coords = new Array(n).fill(null);
    var origemCalculado = new Array(n).fill(false);

    for (var i = 0; i < n; i++) {
      coords[i] = IntegralGeometry.resolveVertexLngLat(vertices[i], doc.sistema);
    }

    var changed = true;
    var guard = 0;
    while (changed && guard < n * 2) {
      changed = false;
      guard++;
      for (var j = 0; j < n; j++) {
        if (coords[j] != null) continue;
        if (j === 0) continue;
        var prev = j - 1;
        if (coords[prev] == null) continue;
        var az = segmentAzimuth(vertices[prev]);
        var dist = vertices[prev].distancia_para_proximo;
        if (az == null || dist == null) continue;
        coords[j] = IntegralCoordinates.destinationPoint(coords[prev], az, Number(dist));
        origemCalculado[j] = true;
        changed = true;
      }
    }

    var resolvedIndexes = [];
    var missingIndexes = [];
    var coordsLngLat = [];
    coords.forEach(function (c, i) {
      if (c) {
        coordsLngLat.push(c);
        resolvedIndexes.push(i);
        if (origemCalculado[i] && vertices[i].origem === "EXTRAIDO") vertices[i].origem = "CALCULADO";
      } else {
        missingIndexes.push(i);
      }
    });

    var semPosicionamentoAbsoluto = false;
    var relativeCoordsLngLat = null;

    if (resolvedIndexes.length === 0 && n >= 3) {
      var rel = new Array(n).fill(null);
      rel[0] = [0, 0];
      var okChain = true;
      for (var k = 0; k < n; k++) {
        var kNext = (k + 1) % n;
        if (kNext === 0) break;
        var azK = segmentAzimuth(vertices[k]);
        var distK = vertices[k].distancia_para_proximo;
        if (rel[k] == null || azK == null || distK == null) { okChain = false; break; }
        var rad = (azK * Math.PI) / 180;
        rel[kNext] = [rel[k][0] + Number(distK) * Math.sin(rad), rel[k][1] + Number(distK) * Math.cos(rad)];
      }
      if (okChain && rel.every(function (p) { return p != null; })) {
        semPosicionamentoAbsoluto = true;
        relativeCoordsLngLat = rel;
        missingIndexes.length = 0;
      }
    }

    doc.coordsLngLat = coordsLngLat;
    doc.resolvedIndexes = resolvedIndexes;
    doc.missingIndexes = missingIndexes;
    doc.semPosicionamentoAbsoluto = semPosicionamentoAbsoluto;
    doc.relativeCoordsLngLat = relativeCoordsLngLat;
  }

  function computeDocumento(doc) {
    reconstructGeometryForDoc(doc);

    if (doc.semPosicionamentoAbsoluto && doc.relativeCoordsLngLat) {
      var ring = doc.relativeCoordsLngLat.slice();
      ring.push(ring[0]);
      try {
        doc.polygonFeature = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
        doc.areaCalculada = Math.abs(shoelaceArea(doc.relativeCoordsLngLat));
        doc.perimetroCalculado = polylinePerimeterPlanar(doc.relativeCoordsLngLat);
      } catch (e) {
        doc.polygonFeature = null;
        doc.areaCalculada = null;
        doc.perimetroCalculado = null;
      }
    } else {
      doc.polygonFeature = IntegralGeometry.buildPolygon(doc.coordsLngLat);
      doc.areaCalculada = IntegralGeometry.calculateAreaM2(doc.polygonFeature);
      doc.perimetroCalculado = IntegralGeometry.calculatePerimeterM(doc.coordsLngLat);
    }

    var areaRegistral = doc.extraido && doc.extraido.imovel ? doc.extraido.imovel.area_registral : null;

    doc.validacoes = IntegralGeometry.runValidations({
      vertices: doc.vertices,
      sistema: doc.sistema,
      coordsLngLat: doc.semPosicionamentoAbsoluto ? [] : doc.coordsLngLat,
      resolvedIndexes: doc.resolvedIndexes,
      missingIndexes: doc.semPosicionamentoAbsoluto ? [] : doc.missingIndexes,
      polygonFeature: doc.polygonFeature,
      areaRegistral: areaRegistral,
      areaCalculada: doc.areaCalculada,
      perimetroRegistral: null,
      perimetroCalculado: doc.perimetroCalculado
    });

    if (doc.semPosicionamentoAbsoluto) {
      doc.validacoes.unshift({
        nivel: "atencao",
        codigo: "SEM_POSICIONAMENTO_ABSOLUTO",
        mensagem:
          "Poligonal reconstruida sem posicionamento geografico absoluto (nenhuma coordenada georreferenciada encontrada). O mapa nao sera exibido; apenas a forma e as medidas relativas."
      });
    }
  }

  function shoelaceArea(coords) {
    var sum = 0;
    for (var i = 0; i < coords.length; i++) {
      var a = coords[i];
      var b = coords[(i + 1) % coords.length];
      sum += a[0] * b[1] - b[0] * a[1];
    }
    return sum / 2;
  }

  function polylinePerimeterPlanar(coords) {
    var total = 0;
    for (var i = 0; i < coords.length; i++) {
      var a = coords[i];
      var b = coords[(i + 1) % coords.length];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return total;
  }

  /** Chamado apos qualquer edicao manual de vertice: recalcula, persiste e re-renderiza tudo que depende disso. */
  function afterDocEdited() {
    var doc = getSelectedDocument();
    if (!doc) return;
    computeDocumento(doc);
    salvarDocumentoAtualizado(doc);
    renderMap();
    renderTabelaEConfrontantes();
    renderValidacao();
    renderDadosExtraidos();
  }

  /**
   * Aplica datum/zona/hemisferio informados MANUALMENTE pelo usuario para um
   * documento cujo texto nao trazia essa informacao. NUNCA e a IA que decide
   * isso - e sempre uma escolha explicita do profissional responsavel, e fica
   * marcada como tal em todo lugar onde o sistema de coordenadas e exibido
   * (painel de dados extraidos, validacao, exportacao).
   */
  function aplicarSistemaManual(doc, datum, zona, hemisferio, camposAlterados) {
    doc.sistema.datum = datum;
    doc.sistema.zona = zona;
    doc.sistema.hemisferio = hemisferio;
    if (!doc.sistema.tipo) doc.sistema.tipo = "UTM";
    doc.sistemaManualCampos = doc.sistemaManualCampos || {};
    camposAlterados = camposAlterados || { datum: true, zona: true, hemisferio: true };
    if (camposAlterados.datum) doc.sistemaManualCampos.datum = true;
    if (camposAlterados.zona) doc.sistemaManualCampos.zona = true;
    if (camposAlterados.hemisferio) doc.sistemaManualCampos.hemisferio = true;
    computeDocumento(doc);
    salvarDocumentoAtualizado(doc);
    state.formSistemaManualDocId = null;
    renderAllForActiveProject();
    renderProjetos();

    if (doc.resolvedIndexes.length === 0) {
      // sistema de referencia completo, mas mesmo assim nenhum vertice posicionou:
      // o problema esta nos proprios vertices (easting/northing/lat-long nao
      // foram extraidos do documento para nenhum deles)
      alert(
        "O sistema de coordenadas foi salvo, mas a matricula ainda nao pode ser posicionada no mapa: " +
        "os proprios vertices desta analise nao tem coordenadas registradas (nao e so o datum/zona que faltava). " +
        "Tente remover esta matricula do projeto (aba Projetos) e analisar o documento de novo - " +
        "isso vai refazer a extracao e pode corrigir o problema."
      );
    }
  }

  /** Reverte os campos que foram informados manualmente, voltando ao que o documento realmente diz (provavelmente null). */
  function removerSistemaManual(doc) {
    if (!doc.sistemaManualCampos) return;
    ["datum", "zona", "hemisferio"].forEach(function (campo) {
      if (doc.sistemaManualCampos[campo]) {
        doc.sistema[campo] = null;
        doc.sistemaManualCampos[campo] = false;
      }
    });
    computeDocumento(doc);
    salvarDocumentoAtualizado(doc);
    renderAllForActiveProject();
    renderProjetos();
  }

  // ==========================================================================
  // RENDER: RESUMO (do documento recem-analisado)
  // ==========================================================================
  function renderResultSummaryFor(doc) {
    var el = document.getElementById("result-summary");
    var m = (doc.extraido && doc.extraido.matricula) || {};
    var areaRegistral = doc.extraido && doc.extraido.imovel ? doc.extraido.imovel.area_registral : null;
    var cmp = IntegralGeometry.compareValues(areaRegistral, doc.areaCalculada);

    var pior = doc.validacoes.reduce(function (acc, v) {
      var rank = { ok: 0, atencao: 1, erro: 2 };
      return rank[v.nivel] > rank[acc] ? v.nivel : acc;
    }, "ok");
    var badgeClass = pior === "ok" ? "rs-badge--ok" : pior === "atencao" ? "rs-badge--warn" : "rs-badge--error";
    var badgeText = pior === "ok" ? "✓ Poligonal valida" : pior === "atencao" ? "⚠ Atencao" : "✕ Erro geometrico";

    var html = "";
    html += '<p class="rs-title">Resultado da analise</p>';
    html += "<h2>" + esc(m.numero ? "Matricula " + m.numero : "Documento analisado") + "</h2>";

    if (doc.situacaoMatricula && doc.situacaoMatricula.ativa === false) {
      html +=
        '<div class="substituicao-banner">⚠ Esta matricula consta como substituida' +
        (doc.situacaoMatricula.substituida_por ? " pela matricula <b>" + esc(doc.situacaoMatricula.substituida_por) + "</b>" : "") +
        ".</div>";
    }

    html += '<div class="rs-grid">';
    html += metricBlock("Vertices identificados", doc.vertices.length);
    html += metricBlock("Sistema", (doc.sistema.datum || "N/D") + (doc.sistema.zona ? " · UTM " + doc.sistema.zona + (doc.sistema.hemisferio || "") : ""));
    html += metricBlock("Area registral", areaRegistral != null ? fmtArea(areaRegistral) : "N/D");
    html += metricBlock(
      "Area calculada",
      doc.areaCalculada != null ? fmtArea(doc.areaCalculada) : "N/D",
      cmp ? (cmp.diferenca < 0 ? "negative" : "positive") : ""
    );
    if (cmp) {
      html += metricBlock(
        "Diferenca",
        fmtArea(cmp.diferenca) + " (" + cmp.percentual.toFixed(3) + "%)",
        cmp.diferenca < 0 ? "negative" : "positive"
      );
    }
    html += metricBlock("Perimetro calculado", doc.perimetroCalculado != null ? fmtLen(doc.perimetroCalculado) : "N/D");
    html += "</div>";
    html += '<span class="rs-badge ' + badgeClass + '">' + badgeText + "</span>";
    html += '<div class="rs-actions">';
    html += '<button class="btn btn-secondary" onclick="IntegralApp.goToView(\'dados-extraidos\')">Ver dados extraidos</button>';
    html += '<button class="btn btn-secondary" onclick="IntegralApp.goToView(\'mapa\')">Ver mapa</button>';
    html += '<button class="btn btn-secondary" onclick="IntegralApp.goToView(\'validacao\')">Ver validacao</button>';
    html += '<button class="btn btn-primary" style="width:auto;margin:0" onclick="IntegralApp.goToView(\'exportacao\')">Exportar</button>';
    html += "</div>";
    el.innerHTML = html;
  }

  function metricBlock(label, value, extraClass) {
    return (
      '<div><div class="rs-metric-label">' + esc(label) + '</div><div class="rs-metric-value ' +
      (extraClass || "") + '">' + esc(String(value)) + "</div></div>"
    );
  }

  // ==========================================================================
  // SELETOR DE DOCUMENTO (componente reutilizavel - pills coloridas)
  // ==========================================================================
  function renderDocSelector(containerId, onChangeRerender) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var project = getActiveProject();
    if (!project || !project.documentos.length) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    var selected = getSelectedDocument();

    el.innerHTML = project.documentos.map(function (doc) {
      var numero = (doc.extraido.matricula && doc.extraido.matricula.numero) || doc.nomeArquivo || "s/n";
      var isActive = selected && doc.id === selected.id;
      var inativa = doc.situacaoMatricula && doc.situacaoMatricula.ativa === false;
      return (
        '<button type="button" class="doc-pill' + (isActive ? " active" : "") + (inativa ? " inativa" : "") + '" data-doc-id="' + doc.id + '">' +
        '<span class="color-dot" style="background:' + doc.cor + '"></span>' + esc(numero) +
        "</button>"
      );
    }).join("");

    el.querySelectorAll("[data-doc-id]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.documentoSelecionadoId = btn.dataset.docId;
        if (onChangeRerender) onChangeRerender();
      });
    });
  }

  // ==========================================================================
  // RENDER: DADOS EXTRAIDOS (secoes 21-22, layout em tabelas)
  // ==========================================================================
  function renderDadosExtraidos() {
    renderDocSelector("dados-extraidos-seletor", renderDadosExtraidos);
    var doc = getSelectedDocument();
    var container = document.getElementById("dados-extraidos-content");

    if (!doc) {
      container.className = "empty-state";
      container.innerHTML = 'Envie e analise um documento na aba "Nova analise" para ver os dados extraidos aqui.';
      return;
    }

    var d = doc.extraido;
    var m = d.matricula || {};
    var p = d.proprietario || {};
    var im = d.imovel || {};
    var sc = doc.sistema || {};
    var numero = m.numero || doc.nomeArquivo || "s/n";
    var areaRegistral = im.area_registral;
    var cmp = IntegralGeometry.compareValues(areaRegistral, doc.areaCalculada);

    var html = "";

    var pior = piorNivel(doc.validacoes);
    var statusBadgeClass = pior === "ok" ? "rs-badge--ok" : pior === "atencao" ? "rs-badge--warn" : "rs-badge--error";
    var statusBadgeText = pior === "ok" ? "✓ Poligonal valida" : pior === "atencao" ? "⚠ Atencao" : "✕ Erro geometrico";

    html += '<div class="card doc-header-card">';
    html += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">';
    html += '<input type="color" id="doc-cor-picker" class="doc-cor-picker" value="' + esc(doc.cor) + '" title="Clique para escolher a cor desta matricula no mapa" />';
    html += "<h2 style=\"margin:0;font-size:20px;\">Matricula " + esc(numero) + "</h2>";
    html += doc.situacaoMatricula && doc.situacaoMatricula.ativa === false
      ? '<span class="rs-badge rs-badge--warn">Substituida</span>'
      : '<span class="rs-badge rs-badge--ok">Ativa</span>';
    html += '<span class="rs-badge ' + statusBadgeClass + '">' + statusBadgeText + "</span>";
    html += "</div>";
    html += '<div class="rs-grid" style="margin-top:16px;">';
    html += metricBlock("Area registral", areaRegistral != null ? fmtArea(areaRegistral, im.unidade_area) : "N/D");
    html += metricBlock("Area calculada", doc.areaCalculada != null ? fmtArea(doc.areaCalculada) : "N/D", cmp ? (cmp.diferenca < 0 ? "negative" : "positive") : "");
    if (cmp) {
      html += metricBlock(
        "Diferenca",
        fmtArea(cmp.diferenca) + " (" + cmp.percentual.toFixed(3) + "%)",
        cmp.diferenca < 0 ? "negative" : "positive"
      );
    }
    html += metricBlock("Perimetro calculado", doc.perimetroCalculado != null ? fmtLen(doc.perimetroCalculado) : "N/D");
    html += metricBlock("Vertices", doc.vertices.length);
    html += "</div></div>";

    if (doc.situacaoMatricula && doc.situacaoMatricula.ativa === false) {
      html +=
        '<div class="substituicao-banner">⚠ O texto deste documento indica que esta matricula foi substituida' +
        (doc.situacaoMatricula.substituida_por
          ? " pela matricula <b>" + esc(doc.situacaoMatricula.substituida_por) + "</b>"
          : " por outra matricula (numero nao identificado)") +
        "." +
        (doc.situacaoMatricula.texto_origem ? '<br/><em>"' + esc(doc.situacaoMatricula.texto_origem) + '"</em>' : "") +
        "</div>";
    }

    html += '<div class="data-grid">';
    html += panelTable("Matricula", [
      ["Numero", m.numero], ["Cartorio", m.cartorio], ["Comarca", m.comarca], ["Municipio", m.municipio], ["UF", m.estado]
    ]);
    html += panelTable("Proprietario", [["Nome", p.nome], ["CPF", p.cpf], ["CNPJ", p.cnpj]]);
    html += panelTable("Imovel", [
      ["Area registral", areaRegistral != null ? fmtArea(areaRegistral, im.unidade_area) : null],
      ["Endereco", im.endereco], ["Lote", im.lote], ["Quadra", im.quadra]
    ]);
    var manualCampos = doc.sistemaManualCampos || {};
    html += panelTable("Georreferenciamento", [
      ["Sistema", sc.tipo],
      ["Datum", sistemaValorComMarca(sc.datum, manualCampos.datum)],
      ["EPSG", sc.epsg],
      ["Zona", sistemaValorComMarca(sc.zona, manualCampos.zona)],
      ["Hemisferio", sistemaValorComMarca(sc.hemisferio, manualCampos.hemisferio)],
      ["Numero de vertices", doc.vertices.length]
    ]);
    html += "</div>";

    if (manualCampos.datum || manualCampos.zona || manualCampos.hemisferio) {
      html +=
        '<p class="sistema-manual-nota">✎ Datum/zona/hemisferio marcados acima foram informados manualmente por voce - nao constam no documento original. ' +
        '<button class="btn-icon-text" id="btn-remover-sistema-manual" type="button">Remover e voltar ao original</button></p>';
    }

    // O botao de informar sistema manualmente deve aparecer sempre que:
    // (a) o sistema e UTM (ou nao identificado) e falta datum/zona/hemisferio, E
    // (b) nenhum vertice foi posicionado de forma absoluta ainda.
    // Isso e INDEPENDENTE de semPosicionamentoAbsoluto (que reflete apenas se
    // a reconstrucao relativa por azimute/distancia deu certo) - mesmo que essa
    // reconstrucao falhe por outro motivo, preencher o sistema pode resolver
    // via posicionamento absoluto direto (easting/northing de cada vertice).
    var faltaDadoSistema =
      doc.sistema.datum == null || doc.sistema.zona == null || doc.sistema.hemisferio == null;
    var precisaSistemaManual =
      (doc.sistema.tipo === "UTM" || doc.sistema.tipo == null) &&
      faltaDadoSistema &&
      doc.resolvedIndexes.length === 0;

    if (precisaSistemaManual) {
      if (state.formSistemaManualDocId === doc.id) {
        html += renderFormularioSistemaManual(doc);
      } else {
        var faltando = [];
        if (!doc.sistema.datum) faltando.push("datum");
        if (doc.sistema.zona == null) faltando.push("zona UTM");
        if (!doc.sistema.hemisferio) faltando.push("hemisferio");
        var temSugestao = doc.sugestaoGeografica && (doc.sugestaoGeografica.zona_utm_sugerida != null || doc.sugestaoGeografica.datum_sugerido);
        html +=
          '<div class="card sistema-manual-cta">' +
          "<h3>Sistema de coordenadas incompleto no documento</h3>" +
          "<p>O documento nao informa " + esc(faltando.join(", ")) + " suficiente(s) para posicionar esta matricula no mapa. " +
          (temSugestao
            ? "A IA identificou o municipio/estado e tem uma sugestao para preencher (voce ainda precisa confirmar)."
            : "Se voce souber essa informacao (pelo seu conhecimento profissional), pode informa-la manualmente.") +
          "</p>" +
          '<button class="btn btn-secondary btn-sm" id="btn-abrir-sistema-manual" type="button">Informar sistema de coordenadas</button>' +
          "</div>";
      }
    }


    html += '<div class="card evidence-list"><h3>Evidencia textual (auditoria)</h3>';
    if (doc.vertices.length === 0) {
      html += '<p class="empty-state-inline">Nenhum vertice identificado.</p>';
    }
    doc.vertices.forEach(function (v) {
      var cls = confidenceClass(v.confianca);
      html +=
        '<div class="evidence-item"><div class="evidence-item-head">' +
        '<span class="evidence-vertex">' + esc(v.id) + "</span>" +
        '<span class="evidence-confidence ' + cls + '">' + Math.round((v.confianca || 0) * 100) + "%</span>" +
        "</div>" +
        '<p class="evidence-text">' + (v.texto_origem ? esc(v.texto_origem) : "Sem trecho de origem registrado.") + "</p>" +
        "</div>";
    });
    html += "</div>";

    if (doc.alertasIA && doc.alertasIA.length) {
      html += '<div class="card"><h3>Alertas da leitura</h3><table class="data-table report-table"><tbody>';
      doc.alertasIA.forEach(function (a, i) {
        html +=
          "<tr><td class=\"report-label\" style=\"width:auto;font-family:var(--font-mono);font-weight:700;\">" + (i + 1) + "</td>" +
          "<td class=\"report-value\" style=\"font-family:var(--font-sans);font-weight:400;text-align:left;\">" + esc(a) + "</td></tr>";
      });
      html += "</table></div>";
    }

    if (doc.matriculasCitadas && doc.matriculasCitadas.length) {
      html += '<div class="card"><h3>Matriculas citadas neste documento</h3><table class="data-table report-table"><tbody>';
      doc.matriculasCitadas.forEach(function (c) {
        html +=
          "<tr><td class=\"report-label\" style=\"width:auto;font-family:var(--font-mono);font-weight:700;\">" + esc(c.numero) + "</td>" +
          "<td class=\"report-value\" style=\"font-family:var(--font-sans);font-weight:400;text-align:left;\">" + esc(c.contexto || "") + "</td></tr>";
      });
      html += "</table></div>";
    }

    if (doc.historicoRegistro && doc.historicoRegistro.length) {
      html += '<div class="card"><h3>Historico de posse e transicao</h3>';
      html += '<div class="table-scroll"><table class="data-table"><thead><tr>';
      html += "<th>Ato</th><th>Data</th><th>Tipo</th><th>De</th><th>Para</th><th>Valor</th><th>Descricao</th>";
      html += "</tr></thead><tbody>";
      doc.historicoRegistro.forEach(function (h) {
        html +=
          "<tr><td class=\"mono\">" + esc(h.ato) + "</td>" +
          "<td>" + esc(h.data || "N/D") + "</td>" +
          "<td>" + esc(h.tipo || "N/D") + "</td>" +
          "<td>" + esc(h.de || "N/D") + "</td>" +
          "<td>" + esc(h.para || "N/D") + "</td>" +
          "<td>" + esc(h.valor || "N/D") + "</td>" +
          "<td>" + esc(h.descricao || "") + "</td></tr>";
      });
      html += "</tbody></table></div></div>";
    }

    container.className = "";
    container.innerHTML = html;

    var pickerCor = document.getElementById("doc-cor-picker");
    if (pickerCor) {
      pickerCor.addEventListener("input", function () {
        doc.cor = pickerCor.value;
        var project = getActiveProject();
        if (project) project.atualizadoEm = new Date().toISOString();
        salvarDocumentoAtualizado(doc);
        renderMap();
        renderDocSelector("dados-extraidos-seletor", renderDadosExtraidos);
        renderTabelaEConfrontantes();
        renderProjetos();
      });
    }

    var btnRemoverSistema = document.getElementById("btn-remover-sistema-manual");
    if (btnRemoverSistema) {
      btnRemoverSistema.addEventListener("click", function () {
        if (!confirm("Remover as informacoes de sistema de coordenadas que voce preencheu manualmente para esta matricula?")) return;
        removerSistemaManual(doc);
      });
    }

    var btnAbrirSistema = document.getElementById("btn-abrir-sistema-manual");
    if (btnAbrirSistema) {
      btnAbrirSistema.addEventListener("click", function () {
        state.formSistemaManualDocId = doc.id;
        renderDadosExtraidos();
      });
    }

    var btnCancelarSistema = document.getElementById("btn-cancelar-sistema-manual");
    if (btnCancelarSistema) {
      btnCancelarSistema.addEventListener("click", function () {
        state.formSistemaManualDocId = null;
        renderDadosExtraidos();
      });
    }

    var btnAplicarSistema = document.getElementById("btn-aplicar-sistema-manual");
    if (btnAplicarSistema) {
      btnAplicarSistema.addEventListener("click", function () {
        var datum = document.getElementById("sm-datum").value;
        var zonaRaw = document.getElementById("sm-zona").value;
        var hemisferio = document.getElementById("sm-hemisferio").value;
        var zona = zonaRaw === "" ? null : parseInt(zonaRaw, 10);
        if (!datum) {
          alert("Selecione um datum.");
          return;
        }
        if (!zona || zona < 1 || zona > 60) {
          alert("Informe uma zona UTM valida (numero de 1 a 60).");
          return;
        }
        var camposAlterados = {
          datum: doc.sistema.datum !== datum,
          zona: doc.sistema.zona !== zona,
          hemisferio: doc.sistema.hemisferio !== hemisferio
        };
        aplicarSistemaManual(doc, datum, zona, hemisferio, camposAlterados);
      });
    }

    // Auto-verificacao: alguns navegadores/extensoes (ex: Google Tradutor) podem
    // reescrever o DOM depois que renderizamos e "perder" elementos dinamicos
    // recem-inseridos. Confere pouco depois se o que deveria estar visivel
    // ainda esta la; se sumiu, tenta redesenhar UMA vez (evita loop infinito
    // via flag) e deixa um aviso claro no console para diagnostico.
    if (precisaSistemaManual && !doc._tentouRedesenharSistemaManual) {
      setTimeout(function () {
        var aindaLa = document.getElementById("btn-abrir-sistema-manual") || document.getElementById("btn-aplicar-sistema-manual");
        if (!aindaLa && getSelectedDocument() === doc) {
          console.warn(
            "[INTEGRAL GEO MATRICULA] O botao de sistema de coordenadas foi renderizado mas desapareceu do DOM logo em seguida. " +
            "Isso normalmente indica uma extensao do navegador (ex: Google Tradutor, leitor de pagina) reescrevendo o conteudo. " +
            "Tentando redesenhar uma vez..."
          );
          doc._tentouRedesenharSistemaManual = true;
          renderDadosExtraidos();
        }
      }, 400);
    }
  }

  function panelTable(title, rows) {
    var html = '<div class="card data-panel"><h3>' + esc(title) + '</h3><table class="data-table report-table"><tbody>';
    rows.forEach(function (r) {
      var label = r[0], value = r[1];
      var isNull = value == null || value === "";
      html +=
        '<tr><td class="report-label">' + esc(label) + "</td>" +
        '<td class="report-value' + (isNull ? " is-null" : "") + '">' +
        (isNull ? "nao identificado" : esc(String(value))) +
        "</td></tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  /** Anexa uma marca visivel (✎) quando o valor foi informado manualmente pelo usuario, nao extraido do documento. */
  function sistemaValorComMarca(valor, manual) {
    if (valor == null || valor === "") return null;
    return manual ? valor + " ✎" : valor;
  }

  var DATUMS_CONHECIDOS = ["SIRGAS2000", "SAD69", "WGS84", "Corrego Alegre", "Astro-Chua"];

  function renderFormularioSistemaManual(doc) {
    var sc = doc.sistema || {};
    var sug = doc.sugestaoGeografica || {};

    // prioridade de preenchimento: 1) ja resolvido (documento ou fato geografico), 2) sugestao da IA, 3) vazio
    var zonaValor = sc.zona != null ? sc.zona : (sug.zona_utm_sugerida != null ? sug.zona_utm_sugerida : "");
    var datumValor = sc.datum != null ? sc.datum : (sug.datum_sugerido || "");
    var zonaVeioDeSugestao = sc.zona == null && sug.zona_utm_sugerida != null;
    var datumVeioDeSugestao = sc.datum == null && sug.datum_sugerido != null;

    var html = '<div class="card sistema-manual-form">';
    html += "<h3>Informar sistema de coordenadas manualmente</h3>";
    html +=
      "<p>Campos ja deduzidos automaticamente (fato geografico, ex: zona/hemisferio pelo estado) vem preenchidos. " +
      "O que voce preencher ou confirmar aqui ficara marcado como informado manualmente (nao extraido do documento) em todo o sistema.</p>";

    if (zonaVeioDeSugestao || datumVeioDeSugestao) {
      html +=
        '<div class="sugestao-ia-box">⚠ <b>Sugestao da IA</b> - baseada na cidade/estado do imovel, NAO extraida do documento nem garantida geograficamente. ' +
        "Confira antes de aplicar." +
        (sug.justificativa ? "<br/><em>" + esc(sug.justificativa) + "</em>" : "") +
        "</div>";
    }

    html += '<div class="form-row">';
    html += '<label>Datum' + (datumVeioDeSugestao ? ' <span class="tag-sugestao-ia">sugestao IA</span>' : "") + '<select id="sm-datum"><option value="">Selecione...</option>' +
      DATUMS_CONHECIDOS.map(function (d) {
        return '<option value="' + esc(d) + '"' + (datumValor === d ? " selected" : "") + '>' + esc(d) + "</option>";
      }).join("") +
      "</select></label>";
    html += '<label>Zona UTM' + (zonaVeioDeSugestao ? ' <span class="tag-sugestao-ia">sugestao IA</span>' : "") +
      '<input id="sm-zona" type="number" min="1" max="60" value="' + zonaValor + '" placeholder="ex: 22" /></label>';
    html += '<label>Hemisferio<select id="sm-hemisferio">' +
      '<option value="S"' + (sc.hemisferio === "S" ? " selected" : "") + '>Sul</option>' +
      '<option value="N"' + (sc.hemisferio === "N" ? " selected" : "") + '>Norte</option>' +
      "</select></label>";
    html += "</div>";
    html += '<div class="form-actions">';
    html += '<button class="btn btn-primary btn-sm" id="btn-aplicar-sistema-manual" type="button">Aplicar e tentar posicionar no mapa</button>';
    html += '<button class="btn btn-secondary btn-sm" id="btn-cancelar-sistema-manual" type="button">Cancelar</button>';
    html += "</div></div>";
    return html;
  }

  function confidenceClass(c) {
    if (c >= 0.9) return "confidence-high";
    if (c >= 0.7) return "confidence-medium";
    return "confidence-low";
  }

  // ==========================================================================
  // RENDER: MAPA (todos os documentos do projeto ativo, cores distintas)
  // ==========================================================================
  function initMap() {
    var mapEl = document.getElementById("map");
    var mapaBase = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19
    });
    var sateliteBase = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles &copy; Esri", maxZoom: 19 }
    );

    state.map = L.map(mapEl, { center: [-14.235, -51.9253], zoom: 4, layers: [mapaBase] });
    state.mapBaseLayers.mapa = mapaBase;
    state.mapBaseLayers.satelite = sateliteBase;

    document.getElementById("btn-base-mapa").addEventListener("click", function () { switchBaseLayer(true); });
    document.getElementById("btn-base-satelite").addEventListener("click", function () { switchBaseLayer(false); });
    document.getElementById("btn-zoom-in").addEventListener("click", function () { state.map.zoomIn(); });
    document.getElementById("btn-zoom-out").addEventListener("click", function () { state.map.zoomOut(); });
    document.getElementById("btn-fit").addEventListener("click", fitMapToAll);
  }

  function switchBaseLayer(useMapa) {
    var m = state.mapBaseLayers;
    if (useMapa) {
      state.map.removeLayer(m.satelite);
      m.mapa.addTo(state.map);
    } else {
      state.map.removeLayer(m.mapa);
      m.satelite.addTo(state.map);
    }
    document.getElementById("btn-base-mapa").classList.toggle("chip--active", useMapa);
    document.getElementById("btn-base-satelite").classList.toggle("chip--active", !useMapa);
  }

  function fitMapToAll() {
    var bounds = null;
    Object.keys(state.mapLayers).forEach(function (id) {
      var l = state.mapLayers[id];
      if (l.polygon && !l._oculta) bounds = bounds ? bounds.extend(l.polygon.getBounds()) : l.polygon.getBounds();
    });
    if (bounds) state.map.fitBounds(bounds, { padding: [30, 30] });
  }

  function renderMap() {
    var project = getActiveProject();

    if (!state.map) initMap();

    // limpa todas as camadas de documentos anteriores
    Object.keys(state.mapLayers).forEach(function (id) {
      var l = state.mapLayers[id];
      if (l.polygon) state.map.removeLayer(l.polygon);
      if (l.vertices) state.map.removeLayer(l.vertices);
    });
    state.mapLayers = {};

    if (!project || project.documentos.length === 0) {
      document.getElementById("mapa-empty").hidden = false;
      document.getElementById("mapa-content").hidden = true;
      return;
    }
    document.getElementById("mapa-empty").hidden = true;
    document.getElementById("mapa-content").hidden = false;

    var semPosCount = 0;

    project.documentos.forEach(function (doc) {
      if (doc.semPosicionamentoAbsoluto || !doc.coordsLngLat || doc.coordsLngLat.length < 3) {
        semPosCount++;
        return;
      }
      var numero = (doc.extraido.matricula && doc.extraido.matricula.numero) || doc.nomeArquivo || "s/n";
      var latlngs = doc.coordsLngLat.map(function (c) { return [c[1], c[0]]; });
      var polygon = L.polygon(latlngs, { color: doc.cor, weight: 2.5, fillColor: doc.cor, fillOpacity: 0.16 }).addTo(state.map);

      var substituidaTxt = doc.situacaoMatricula && doc.situacaoMatricula.ativa === false
        ? "<br/><b style='color:#c0362c'>Substituida" + (doc.situacaoMatricula.substituida_por ? " pela " + esc(doc.situacaoMatricula.substituida_por) : "") + "</b>"
        : "";
      polygon.bindPopup(
        "<b>Matricula " + esc(numero) + "</b><br/>" +
        "Area calculada: " + (doc.areaCalculada != null ? fmtArea(doc.areaCalculada) : "N/D") +
        substituidaTxt
      );
      polygon.on("click", function () {
        state.documentoSelecionadoId = doc.id;
        renderTabelaEConfrontantes();
      });

      var markersGroup = L.layerGroup();
      doc.resolvedIndexes.forEach(function (vIdx, orderIdx) {
        var vertex = doc.vertices[vIdx];
        var coord = doc.coordsLngLat[orderIdx];
        var marker = L.circleMarker([coord[1], coord[0]], {
          radius: 5, color: "#ffffff", weight: 2, fillColor: doc.cor, fillOpacity: 1
        });
        var dist = vertex.distancia_para_proximo != null ? fmtLen(vertex.distancia_para_proximo) : "N/D";
        var az = vertex.azimute_para_proximo || "N/D";
        var conf = vertex.confrontante_para_proximo || "N/D";
        marker.bindPopup(
          "<b>" + esc(numero) + " - " + esc(vertex.id) + "</b><br/>" +
          "Distancia ao proximo: " + dist + "<br/>Azimute: " + esc(az) + "<br/>Confrontante: " + esc(conf)
        );
        markersGroup.addLayer(marker);
      });
      markersGroup.addTo(state.map);

      state.mapLayers[doc.id] = { polygon: polygon, vertices: markersGroup, _oculta: false };
    });

    renderLegenda(project);
    fitMapToAll();

    if (semPosCount === project.documentos.length && project.documentos.length > 0) {
      // nenhum documento do projeto tem posicionamento absoluto
      var warn = document.getElementById("mapa-sem-posicionamento");
      if (!warn) {
        warn = document.createElement("div");
        warn.id = "mapa-sem-posicionamento";
        warn.className = "card";
        document.getElementById("mapa-content").insertBefore(warn, document.getElementById("mapa-content").firstChild);
      }
      warn.innerHTML =
        "<h3>Mapa indisponivel</h3><p>Nenhum documento deste projeto tem posicionamento geografico absoluto. A forma e as medidas estao disponiveis na tabela de vertices, mas nao sao exibidas no mapa para evitar posicionamento incorreto. " +
        'Se o documento usa coordenadas UTM mas nao informa datum/zona/hemisferio, voce pode informar isso manualmente na aba "Dados extraidos".</p>';
    } else {
      var existingWarn = document.getElementById("mapa-sem-posicionamento");
      if (existingWarn) existingWarn.remove();
    }

    renderTabelaEConfrontantes();
  }

  function renderLegenda(project) {
    var el = document.getElementById("mapa-legenda");
    if (!project || !project.documentos.length) { el.innerHTML = ""; return; }
    el.innerHTML = project.documentos.map(function (doc) {
      var numero = (doc.extraido.matricula && doc.extraido.matricula.numero) || doc.nomeArquivo || "s/n";
      var layers = state.mapLayers[doc.id];
      var semGeo = !layers;
      var oculta = layers && layers._oculta;
      return (
        '<span class="legenda-item' + (oculta ? " oculta" : "") + '"' +
        (semGeo ? ' style="opacity:0.4;cursor:default;" title="Sem posicionamento no mapa"' : ' data-legenda-doc="' + doc.id + '"') +
        '><span class="color-dot" style="background:' + doc.cor + '"></span>' + esc(numero) + "</span>"
      );
    }).join("");

    el.querySelectorAll("[data-legenda-doc]").forEach(function (item) {
      item.addEventListener("click", function () { toggleDocVisibility(item.dataset.legendaDoc); });
    });
  }

  function toggleDocVisibility(docId) {
    var layers = state.mapLayers[docId];
    if (!layers) return;
    layers._oculta = !layers._oculta;
    if (layers._oculta) {
      if (layers.polygon) state.map.removeLayer(layers.polygon);
      if (layers.vertices) state.map.removeLayer(layers.vertices);
    } else {
      if (layers.polygon) layers.polygon.addTo(state.map);
      if (layers.vertices) layers.vertices.addTo(state.map);
    }
    renderLegenda(getActiveProject());
  }

  // ==========================================================================
  // RENDER: TABELA DE VERTICES + CONFRONTANTES (documento selecionado)
  // ==========================================================================
  function renderTabelaEConfrontantes() {
    renderDocSelector("mapa-tabela-seletor", renderTabelaEConfrontantes);
    renderTabelaVertices();
    renderConfrontantes();
  }

  function renderTabelaVertices() {
    var doc = getSelectedDocument();
    var tbody = document.getElementById("tabela-vertices-body");
    tbody.innerHTML = "";
    if (!doc) return;

    var usaUTM = doc.sistema && doc.sistema.tipo === "UTM";

    doc.vertices.forEach(function (v, idx) {
      var tr = document.createElement("tr");
      var xValue = usaUTM ? v.easting : v.longitude;
      var yValue = usaUTM ? v.northing : v.latitude;

      tr.innerHTML =
        '<td class="mono">' + esc(v.id) + "</td>" +
        '<td><span class="origem-tag origem-' + v.origem + '">' + v.origem + "</span></td>" +
        '<td><input data-field="x" data-idx="' + idx + '" type="number" step="any" value="' + (xValue != null ? xValue : "") + '" /></td>' +
        '<td><input data-field="y" data-idx="' + idx + '" type="number" step="any" value="' + (yValue != null ? yValue : "") + '" /></td>' +
        '<td><input data-field="distancia_para_proximo" data-idx="' + idx + '" type="number" step="any" value="' + (v.distancia_para_proximo != null ? v.distancia_para_proximo : "") + '" /></td>' +
        '<td><input data-field="azimute_para_proximo" data-idx="' + idx + '" type="text" value="' + (v.azimute_para_proximo ? esc(v.azimute_para_proximo) : "") + '" /></td>' +
        '<td><input data-field="confrontante_para_proximo" data-idx="' + idx + '" type="text" value="' + (v.confrontante_para_proximo ? esc(v.confrontante_para_proximo) : "") + '" /></td>' +
        '<td class="confidence-cell">' + Math.round((v.confianca || 0) * 100) + "%</td>" +
        '<td><button class="row-delete" data-idx="' + idx + '" title="Remover vertice">✕</button></td>';
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll("input").forEach(function (input) {
      input.addEventListener("change", onVertexFieldChange);
    });
    tbody.querySelectorAll(".row-delete").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var doc2 = getSelectedDocument();
        if (!doc2) return;
        var idx2 = parseInt(btn.dataset.idx, 10);
        doc2.vertices.splice(idx2, 1);
        afterDocEdited();
      });
    });
  }

  function onVertexFieldChange(e) {
    var doc = getSelectedDocument();
    if (!doc) return;
    var idx = parseInt(e.target.dataset.idx, 10);
    var field = e.target.dataset.field;
    var vertex = doc.vertices[idx];
    if (!vertex) return;

    var usaUTM = doc.sistema && doc.sistema.tipo === "UTM";
    var rawValue = e.target.value;
    var numericFields = ["x", "y", "distancia_para_proximo"];

    if (field === "x") {
      var xn = rawValue === "" ? null : parseFloat(rawValue);
      if (usaUTM) vertex.easting = xn; else vertex.longitude = xn;
    } else if (field === "y") {
      var yn = rawValue === "" ? null : parseFloat(rawValue);
      if (usaUTM) vertex.northing = yn; else vertex.latitude = yn;
    } else if (numericFields.indexOf(field) !== -1) {
      vertex[field] = rawValue === "" ? null : parseFloat(rawValue);
    } else {
      vertex[field] = rawValue === "" ? null : rawValue;
    }

    if (vertex.origem === "EXTRAIDO") vertex.origem = "EDITADO";
    afterDocEdited();
  }

  function renderConfrontantes() {
    var doc = getSelectedDocument();
    var el = document.getElementById("lista-confrontantes");
    if (!doc || !doc.confrontantes || doc.confrontantes.length === 0) {
      el.innerHTML = '<p class="empty-state-inline">Nenhum confrontante identificado.</p>';
      return;
    }
    var html = '<div class="table-scroll"><table class="data-table"><thead><tr>' +
      "<th>De</th><th>Ate</th><th>Nome</th><th>Tipo</th><th>Distancia</th><th>Azimute</th>" +
      "</tr></thead><tbody>";
    doc.confrontantes.forEach(function (c) {
      html +=
        "<tr><td>" + esc(c.vertice_inicial) + "</td><td>" + esc(c.vertice_final) + "</td>" +
        "<td>" + esc(c.nome) + "</td><td>" + esc(c.tipo) + "</td>" +
        "<td>" + (c.distancia != null ? fmtLen(c.distancia) : "N/D") + "</td>" +
        "<td>" + esc(c.azimute) + "</td></tr>";
    });
    html += "</tbody></table></div>";
    el.innerHTML = html;
  }

  function initTableActions() {
    document.getElementById("btn-add-vertice").addEventListener("click", function () {
      var doc = getSelectedDocument();
      if (!doc) { alert("Selecione ou analise uma matricula primeiro."); return; }
      var nextNum = doc.vertices.length + 1;
      doc.vertices.push({
        id: "V" + String(nextNum).padStart(2, "0"),
        origem: "EDITADO",
        latitude: null, longitude: null, easting: null, northing: null,
        distancia_para_proximo: null, azimute_para_proximo: null, rumo_para_proximo: null,
        confrontante_para_proximo: null, texto_origem: null, confianca: 0
      });
      afterDocEdited();
    });
  }

  // ==========================================================================
  // RENDER: VALIDACAO (todos os documentos do projeto, agrupados)
  // ==========================================================================
  function renderValidacao() {
    var container = document.getElementById("validacao-content");
    var project = getActiveProject();

    if (!project || project.documentos.length === 0) {
      container.className = "empty-state";
      container.innerHTML = 'Envie e analise um documento na aba "Nova analise" para ver as validacoes aqui.';
      return;
    }
    container.className = "";

    var icon = { ok: "✓", atencao: "⚠", erro: "✕" };
    var html = "";

    project.documentos.forEach(function (doc, i) {
      var numero = (doc.extraido.matricula && doc.extraido.matricula.numero) || doc.nomeArquivo || "s/n";
      html +=
        '<h3 style="display:flex;align-items:center;gap:8px;margin:' + (i === 0 ? "0" : "26px") + ' 0 10px;">' +
        '<span class="color-dot" style="background:' + doc.cor + '"></span>Matricula ' + esc(numero) + "</h3>";

      var all = doc.validacoes.slice();
      (doc.alertasIA || []).forEach(function (msg) {
        all.push({ nivel: "atencao", codigo: "ALERTA_LEITURA", mensagem: msg });
      });
      if (doc.situacaoMatricula && doc.situacaoMatricula.ativa === false) {
        all.unshift({
          nivel: "atencao",
          codigo: "MATRICULA_SUBSTITUIDA",
          mensagem: "Esta matricula foi substituida" + (doc.situacaoMatricula.substituida_por ? " pela matricula " + doc.situacaoMatricula.substituida_por : "") + "."
        });
      }

      var mc = doc.sistemaManualCampos;
      if (mc && (mc.datum || mc.zona || mc.hemisferio)) {
        all.unshift({
          nivel: "atencao",
          codigo: "SISTEMA_MANUAL",
          mensagem: "O datum/zona/hemisferio desta matricula foi informado manualmente pelo usuario - nao consta no documento original. Confira antes de usar para fins oficiais."
        });
      }

      html += '<div class="validation-list">';
      all.forEach(function (v) {
        html +=
          '<div class="validation-item validation-item--' + v.nivel + '">' +
          '<span class="v-icon">' + icon[v.nivel] + "</span>" +
          "<span>" + esc(v.mensagem) + "</span>" +
          "</div>";
      });
      html += "</div>";
    });

    container.innerHTML = html;
  }

  // ==========================================================================
  // RENDER: EXPORTACAO (documento selecionado + projeto inteiro)
  // ==========================================================================
  function buildExportDataForDoc(doc) {
    return {
      matricula: doc.extraido.matricula,
      proprietario: doc.extraido.proprietario,
      sistemaCoordenadas: doc.sistema,
      areaRegistral: doc.extraido.imovel ? doc.extraido.imovel.area_registral : null,
      areaCalculada: doc.areaCalculada,
      perimetroCalculado: doc.perimetroCalculado,
      vertices: doc.vertices,
      coordsLngLat: doc.coordsLngLat,
      alertas: doc.validacoes,
      situacaoMatricula: doc.situacaoMatricula
    };
  }

  function downloadBlob(content, filename, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function fileBaseNameForDoc(doc) {
    var num = doc.extraido && doc.extraido.matricula ? doc.extraido.matricula.numero : null;
    return "integral-geo-matricula-" + (num || "documento").toString().replace(/[^a-z0-9]+/gi, "-");
  }

  function projectFileBaseName(project) {
    return "integral-geo-matricula-projeto-" + (project.nome || "sem-nome").toString().replace(/[^a-z0-9]+/gi, "-");
  }

  function initExportButtons() {
    document.getElementById("btn-export-geojson").addEventListener("click", function () {
      var doc = getSelectedDocument();
      if (!doc) return;
      if (doc.semPosicionamentoAbsoluto) return alert("Exportacao indisponivel: poligonal sem posicionamento geografico absoluto.");
      downloadBlob(JSON.stringify(IntegralExport.toGeoJSON(buildExportDataForDoc(doc)), null, 2), fileBaseNameForDoc(doc) + ".geojson", "application/geo+json");
    });
    document.getElementById("btn-export-kml").addEventListener("click", function () {
      var doc = getSelectedDocument();
      if (!doc) return;
      if (doc.semPosicionamentoAbsoluto) return alert("Exportacao indisponivel: poligonal sem posicionamento geografico absoluto.");
      downloadBlob(IntegralExport.toKML(buildExportDataForDoc(doc)), fileBaseNameForDoc(doc) + ".kml", "application/vnd.google-earth.kml+xml");
    });
    document.getElementById("btn-export-csv").addEventListener("click", function () {
      var doc = getSelectedDocument();
      if (!doc) return;
      downloadBlob(IntegralExport.toCSV(buildExportDataForDoc(doc)), fileBaseNameForDoc(doc) + ".csv", "text/csv;charset=utf-8");
    });
    document.getElementById("btn-export-txt").addEventListener("click", function () {
      var doc = getSelectedDocument();
      if (!doc) return;
      downloadBlob(IntegralExport.toTXT(buildExportDataForDoc(doc)), fileBaseNameForDoc(doc) + ".txt", "text/plain;charset=utf-8");
    });

    document.getElementById("btn-export-projeto-geojson").addEventListener("click", function () {
      var project = getActiveProject();
      if (!project || !project.documentos.length) return;
      var datas = project.documentos.map(buildExportDataForDoc);
      downloadBlob(JSON.stringify(IntegralExport.toGeoJSONMulti(datas), null, 2), projectFileBaseName(project) + ".geojson", "application/geo+json");
    });
    document.getElementById("btn-export-projeto-kml").addEventListener("click", function () {
      var project = getActiveProject();
      if (!project || !project.documentos.length) return;
      var datas = project.documentos.map(buildExportDataForDoc);
      downloadBlob(IntegralExport.toKMLMulti(datas, project.nome), projectFileBaseName(project) + ".kml", "application/vnd.google-earth.kml+xml");
    });
    document.getElementById("btn-export-projeto-csv").addEventListener("click", function () {
      var project = getActiveProject();
      if (!project || !project.documentos.length) return;
      var datas = project.documentos.map(buildExportDataForDoc);
      downloadBlob(IntegralExport.toCSVMulti(datas), projectFileBaseName(project) + ".csv", "text/csv;charset=utf-8");
    });
    document.getElementById("btn-export-projeto-txt").addEventListener("click", function () {
      var project = getActiveProject();
      if (!project || !project.documentos.length) return;
      var datas = project.documentos.map(buildExportDataForDoc);
      var citadas = computeMatriculasCitadas(project);
      downloadBlob(IntegralExport.toTXTProjeto(project.nome, datas, citadas), projectFileBaseName(project) + ".txt", "text/plain;charset=utf-8");
    });
  }

  function renderExportacao() {
    var project = getActiveProject();
    var empty = document.getElementById("exportacao-empty");
    var content = document.getElementById("exportacao-content");
    if (!project || !project.documentos.length) {
      empty.hidden = false;
      content.hidden = true;
      return;
    }
    empty.hidden = true;
    content.hidden = false;
    renderDocSelector("exportacao-seletor", renderExportacao);
  }

  // ==========================================================================
  // MATRICULAS CITADAS (agregado do projeto - secao 5 da conversa)
  // ==========================================================================
  function normalizarNumeroMatricula(s) {
    if (!s) return null;
    var only = String(s).replace(/[^\d]/g, "");
    return only || null;
  }

  function computeMatriculasCitadas(project) {
    if (!project) return [];
    var analisadas = {};
    project.documentos.forEach(function (d) {
      var num = d.extraido.matricula && d.extraido.matricula.numero;
      var norm = normalizarNumeroMatricula(num);
      if (norm) analisadas[norm] = true;
    });

    var map = {};
    project.documentos.forEach(function (d) {
      var numeroAtual = (d.extraido.matricula && d.extraido.matricula.numero) || d.nomeArquivo;
      (d.matriculasCitadas || []).forEach(function (c) {
        var norm = normalizarNumeroMatricula(c.numero);
        if (!norm || analisadas[norm]) return;
        if (!map[norm]) map[norm] = { numero: c.numero, contextos: [] };
        map[norm].contextos.push("citada em " + numeroAtual + (c.contexto ? " (" + c.contexto + ")" : ""));
      });
      if (d.situacaoMatricula && d.situacaoMatricula.substituida_por) {
        var norm2 = normalizarNumeroMatricula(d.situacaoMatricula.substituida_por);
        if (norm2 && !analisadas[norm2]) {
          if (!map[norm2]) map[norm2] = { numero: d.situacaoMatricula.substituida_por, contextos: [] };
          map[norm2].contextos.push("substitui a matricula " + numeroAtual);
        }
      }
    });

    return Object.keys(map).map(function (k) {
      return { numero: map[k].numero, contexto: map[k].contextos.join(" · ") };
    });
  }

  // ==========================================================================
  // RENDER: PROJETOS
  // ==========================================================================
  var VALIDACAO_BADGE_CLASS = { ok: "rs-badge--ok", atencao: "rs-badge--warn", erro: "rs-badge--error" };
  var VALIDACAO_BADGE_TEXT = { ok: "Valido", atencao: "Atencao", erro: "Erro" };

  function piorNivel(validacoes) {
    return (validacoes || []).reduce(function (acc, v) {
      var rank = { ok: 0, atencao: 1, erro: 2 };
      return rank[v.nivel] > rank[acc] ? v.nivel : acc;
    }, "ok");
  }

  function renderProjetos() {
    var empty = document.getElementById("projetos-empty");
    var content = document.getElementById("projetos-content");

    if (!state.projetos.length) {
      empty.hidden = false;
      content.hidden = true;
      return;
    }
    empty.hidden = true;
    content.hidden = false;

    var project = getActiveProject();
    document.getElementById("projeto-ativo-titulo").textContent = project ? project.nome : "Nenhum projeto ativo";

    var docsList = document.getElementById("projeto-documentos-lista");
    if (!project || project.documentos.length === 0) {
      docsList.innerHTML = '<p class="empty-state-inline">Nenhuma matricula neste projeto ainda.</p>';
    } else {
      var html = '<table class="data-table"><thead><tr>' +
        "<th>Matricula</th><th>Arquivo</th><th>Analisado em</th><th>Vertices</th><th>Status</th><th></th>" +
        "</tr></thead><tbody>";
      project.documentos.forEach(function (doc) {
        var numero = (doc.extraido.matricula && doc.extraido.matricula.numero) || "s/n";
        var dt = new Date(doc.dataAnalise);
        var dataFmt = isNaN(dt.getTime()) ? "N/D" : dt.toLocaleDateString("pt-BR") + " " + dt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        var pior = piorNivel(doc.validacoes);
        var badgeClass = VALIDACAO_BADGE_CLASS[pior] || "rs-badge--ok";
        var badgeText = VALIDACAO_BADGE_TEXT[pior] || "OK";
        if (doc.situacaoMatricula && doc.situacaoMatricula.ativa === false) { badgeClass = "rs-badge--warn"; badgeText = "Substituida"; }

        html +=
          "<tr><td><span class=\"color-dot\" style=\"background:" + doc.cor + ";margin-right:6px;\"></span>" +
          "<span class=\"mono\">" + esc(numero) + "</span></td>" +
          "<td>" + esc(doc.nomeArquivo || "N/D") + "</td>" +
          "<td>" + esc(dataFmt) + "</td>" +
          "<td>" + doc.vertices.length + "</td>" +
          "<td><span class=\"rs-badge " + badgeClass + "\">" + badgeText + "</span></td>" +
          "<td style=\"white-space:nowrap\">" +
          '<button class="btn-icon-text" data-ver-doc="' + doc.id + '" style="color:var(--accent);text-decoration:none;font-weight:700;">Ver</button> · ' +
          '<button class="btn-icon-text" data-remover-doc="' + doc.id + '">Remover</button>' +
          "</td></tr>";
      });
      html += "</tbody></table>";
      docsList.innerHTML = html;

      docsList.querySelectorAll("[data-ver-doc]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          state.documentoSelecionadoId = btn.dataset.verDoc;
          goToView("dados-extraidos");
        });
      });
      docsList.querySelectorAll("[data-remover-doc]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (!confirm("Remover esta matricula do projeto?")) return;
          var id = btn.dataset.removerDoc;
          project.documentos = project.documentos.filter(function (d) { return d.id !== id; });
          project.atualizadoEm = new Date().toISOString();
          if (state.documentoSelecionadoId === id) state.documentoSelecionadoId = null;
          excluirDocumentoNoServidor(id).catch(function (e) { console.error("[sync] erro ao excluir documento:", e); });
          tocarProjetoNoServidor(project.id).catch(function () {});
          renderProjetos();
          renderAllForActiveProject();
        });
      });
    }

    var citadas = computeMatriculasCitadas(project);
    var citEl = document.getElementById("matriculas-citadas-content");
    if (!citadas.length) {
      citEl.className = "empty-state-inline";
      citEl.textContent = "Nenhuma pendencia identificada.";
    } else {
      citEl.className = "";
      var h = '<table class="data-table"><thead><tr><th>Numero</th><th>Contexto</th></tr></thead><tbody>';
      citadas.forEach(function (c) {
        h += "<tr><td class=\"mono\">" + esc(c.numero) + "</td><td>" + esc(c.contexto || "") + "</td></tr>";
      });
      h += "</tbody></table>";
      citEl.innerHTML = h;
    }

    var meuUserId = window.__auth ? window.__auth.getUserId() : null;
    var souAdmin = window.__auth && window.__auth.ehAdmin();
    var todosEl = document.getElementById("lista-todos-projetos");

    function linhaProjeto(p) {
      return (
        '<div class="proj-row' + (p.id === state.projetoAtivoId ? " is-active" : "") + '">' +
        '<div class="proj-row-info"><div>' +
        '<div class="proj-row-name">' + esc(p.nome) + "</div>" +
        '<div class="proj-row-meta">' + p.documentos.length + " documento(s)</div>" +
        "</div></div>" +
        '<div class="proj-row-actions">' +
        (p.id === state.projetoAtivoId
          ? '<span style="color:var(--accent);font-weight:700;font-size:12px;">Ativo</span>'
          : '<button class="btn-icon-text" data-switch-proj="' + p.id + '">Ativar</button>') +
        "</div></div>"
      );
    }

    if (souAdmin) {
      // Agrupa por dono - cada usuario vira uma mini-aba expansivel (acordeao nativo)
      var grupos = {};
      var ordemGrupos = [];
      state.projetos.forEach(function (p) {
        var uid = p.userId || "desconhecido";
        if (!grupos[uid]) {
          grupos[uid] = { nome: p.donoNome, email: p.donoEmail, projetos: [] };
          ordemGrupos.push(uid);
        }
        grupos[uid].projetos.push(p);
      });
      // O proprio usuario aparece primeiro e ja vem aberto
      ordemGrupos.sort(function (a, b) {
        if (a === meuUserId) return -1;
        if (b === meuUserId) return 1;
        return 0;
      });

      todosEl.innerHTML = ordemGrupos.map(function (uid) {
        var g = grupos[uid];
        var souEu = uid === meuUserId;
        var label = souEu ? "Você" : (g.nome || g.email || "Usuário desconhecido");
        return (
          '<details class="usuario-projetos-grupo"' + (souEu ? " open" : "") + '>' +
          "<summary><span>" + esc(label) + "</span>" +
          '<span class="usuario-projetos-count">' + g.projetos.length + " projeto(s)</span></summary>" +
          '<div class="usuario-projetos-lista">' + g.projetos.map(linhaProjeto).join("") + "</div>" +
          "</details>"
        );
      }).join("");
    } else {
      todosEl.innerHTML = state.projetos.map(linhaProjeto).join("");
    }

    todosEl.querySelectorAll("[data-switch-proj]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        switchProject(btn.dataset.switchProj);
        renderProjetos();
        renderAllForActiveProject();
      });
    });
  }

  function initProjetos() {
    document.getElementById("btn-novo-projeto").addEventListener("click", function () {
      var nome = window.prompt("Nome do novo projeto:", "Projeto " + new Date().toLocaleDateString("pt-BR"));
      if (!nome) return;
      createProject(nome.trim());
      renderProjetos();
      renderAllForActiveProject();
    });

    document.getElementById("btn-renomear-projeto").addEventListener("click", function () {
      var project = getActiveProject();
      if (!project) return;
      var novo = window.prompt("Novo nome do projeto:", project.nome);
      if (!novo) return;
      project.nome = novo.trim();
      project.atualizadoEm = new Date().toISOString();
      renomearProjetoNoServidor(project.id, project.nome).catch(function (e) { console.error("[sync] erro ao renomear projeto:", e); });
      populateProjectSelect();
      renderProjetos();
    });

    document.getElementById("btn-excluir-projeto").addEventListener("click", function () {
      var project = getActiveProject();
      if (!project) return;
      if (!confirm('Excluir o projeto "' + project.nome + '" e ' + project.documentos.length + ' matricula(s)? Essa acao nao pode ser desfeita.')) return;
      state.projetos = state.projetos.filter(function (p) { return p.id !== project.id; });
      state.projetoAtivoId = state.projetos.length ? state.projetos[0].id : null;
      state.documentoSelecionadoId = null;
      excluirProjetoNoServidor(project.id).catch(function (e) { console.error("[sync] erro ao excluir projeto:", e); });
      populateProjectSelect();
      renderProjetos();
      renderAllForActiveProject();
    });

    document.getElementById("seletor-projeto").addEventListener("change", function (e) {
      var val = e.target.value;
      if (val === "__novo__") {
        var nome = window.prompt("Nome do novo projeto:", "Projeto " + new Date().toLocaleDateString("pt-BR"));
        if (nome) {
          createProject(nome.trim());
          renderAllForActiveProject();
          renderProjetos();
        } else {
          populateProjectSelect();
        }
        return;
      }
      switchProject(val);
      renderAllForActiveProject();
      renderProjetos();
    });
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================
  function esc(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtArea(m2, unidade) {
    if (m2 == null || isNaN(m2)) return "N/D";
    return Number(m2).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (unidade || "m²");
  }
  function fmtLen(m) {
    if (m == null || isNaN(m)) return "N/D";
    return Number(m).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " m";
  }

  function renderAllForActiveProject() {
    renderMap();
    renderDadosExtraidos();
    renderTabelaEConfrontantes();
    renderValidacao();
    renderExportacao();
    var rs = document.getElementById("result-summary");
    if (rs) rs.hidden = true;
  }

  // ==========================================================================
  // BOOT (chamado por auth.js SOMENTE depois de confirmada a sessao)
  // ==========================================================================
  /**
   * Migracao unica: esta conta pode ter projetos salvos so no localStorage de
   * uma versao anterior do app (antes de existir sincronizacao com o
   * servidor). Se o servidor ainda estiver vazio E existir esse dado antigo
   * no navegador, sobe tudo para o servidor automaticamente, uma vez so.
   */
  async function migrarProjetosAntigosDoLocalStorageSeNecessario() {
    if (state.projetos.length > 0) return; // ja tem dado no servidor, nao mexe em nada
    try {
      if (window.localStorage.getItem(MIGRACAO_FEITA_KEY) === "1") return;
      var raw = window.localStorage.getItem(PROJECTS_KEY);
      var antigos = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(antigos) || antigos.length === 0) {
        window.localStorage.setItem(MIGRACAO_FEITA_KEY, "1");
        return;
      }

      setStatusPill("processing", "Encontramos projetos salvos neste navegador - enviando para sua conta...");
      for (var i = 0; i < antigos.length; i++) {
        var p = antigos[i];
        await criarProjetoNoServidor(p.id, p.nome);
        for (var j = 0; j < (p.documentos || []).length; j++) {
          await salvarDocumentoNoServidorAsync(p.id, p.documentos[j]);
        }
      }
      state.projetos = await carregarProjetosDoServidor();
      window.localStorage.setItem(MIGRACAO_FEITA_KEY, "1");
    } catch (e) {
      console.error("[sync] falha na migracao automatica de projetos antigos:", e);
    }
  }

  var _appJaIniciado = false;
  async function iniciarAppPrincipal() {
    if (_appJaIniciado) return; // evita reinicializar em trocas de sessao/refresh de token
    _appJaIniciado = true;

    setStatusPill("processing", "Carregando seus projetos...");
    try {
      state.projetos = await carregarProjetosDoServidor();
    } catch (e) {
      console.error("[sync] falha ao carregar projetos do servidor:", e);
      state.projetos = [];
    }

    await migrarProjetosAntigosDoLocalStorageSeNecessario();

    var savedActive = null;
    try { savedActive = window.localStorage.getItem(ACTIVE_PROJECT_KEY); } catch (e) {}
    state.projetoAtivoId =
      savedActive && state.projetos.some(function (p) { return p.id === savedActive; })
        ? savedActive
        : (state.projetos[0] ? state.projetos[0].id : null);

    var activeProj = getActiveProject();
    state.documentoSelecionadoId = activeProj && activeProj.documentos.length
      ? activeProj.documentos[activeProj.documentos.length - 1].id
      : null;

    populateProjectSelect();
    initNav();
    initUpload();
    initTableActions();
    initExportButtons();
    initProjetos();

    renderAllForActiveProject();
    renderProjetos();
    setStatusPill("idle", "Aguardando documento");
  }

  window.IntegralApp = { goToView: goToView };
  window.__iniciarAppPrincipal = iniciarAppPrincipal;
})();
