/**
 * app.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA - orquestracao do frontend.
 *
 * Fluxo:
 *   1. Usuario envia documento -> upload direto ao Vercel Blob (api/blob-upload.js)
 *   2. Navegador manda a URL do Blob para POST /api/analisar-documento
 *   3. Backend chama o Claude (Anthropic) e devolve JSON com os dados IDENTIFICADOS.
 *   4. A partir daqui, TUDO e deterministico (sem IA): resolucao de
 *      coordenadas, construcao da poligonal, area, perimetro e validacoes
 *      (lib/coordinates.js e lib/geometry.js).
 *   5. O usuario pode editar qualquer vertice; toda edicao recalcula tudo.
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

  /** Estado global da aplicacao (unica fonte de verdade). */
  var state = {
    file: null,
    blobUrl: null,
    extraido: null, // resposta bruta da IA (normalizada)
    sistema: null, // { tipo, datum, epsg, zona, hemisferio }
    vertices: [], // lista de trabalho (editavel)
    confrontantes: [],
    alertasIA: [],
    coordsLngLat: [],
    resolvedIndexes: [],
    missingIndexes: [],
    semPosicionamentoAbsoluto: false,
    polygonFeature: null,
    areaCalculada: null,
    perimetroCalculado: null,
    validacoes: [],
    map: null,
    mapLayers: { polygon: null, vertices: null, baseMapa: null, baseSatelite: null }
  };

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
        if (btn.dataset.view === "mapa" && state.map) {
          setTimeout(function () { state.map.invalidateSize(); }, 50);
        }
      });
    });
  }

  function goToView(name) {
    var btn = document.querySelector('.nav-item[data-view="' + name + '"]');
    if (btn) btn.click();
  }

  // ==========================================================================
  // UPLOAD
  // ==========================================================================
  function initUpload() {
    var dropzone = document.getElementById("dropzone");
    var fileInput = document.getElementById("file-input");
    var btnSelecionar = document.getElementById("btn-selecionar");
    var btnRemover = document.getElementById("btn-remover");
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
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileSelected(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) handleFileSelected(fileInput.files[0]);
    });

    btnRemover.addEventListener("click", function () {
      state.file = null;
      state.blobUrl = null;
      fileInput.value = "";
      document.getElementById("file-selected").hidden = true;
      document.getElementById("dropzone").hidden = false;
      btnAnalisar.disabled = true;
      hideUploadError();
    });

    btnAnalisar.addEventListener("click", runAnalysis);
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

  function handleFileSelected(file) {
    hideUploadError();
    var ext = file.name.split(".").pop().toLowerCase();
    var typeOk =
      ALLOWED_TYPES.indexOf(file.type) !== -1 ||
      ["pdf", "jpg", "jpeg", "png", "webp"].indexOf(ext) !== -1;

    if (!typeOk) {
      showUploadError("Formato nao suportado. Envie PDF, JPG, JPEG, PNG ou WEBP.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showUploadError(
        "Arquivo muito grande (" + (file.size / 1000000).toFixed(2) + " MB). Limite: " +
          (MAX_FILE_BYTES / 1000000).toFixed(1) + " MB."
      );
      return;
    }

    state.file = file;
    document.getElementById("file-name").textContent = file.name;
    document.getElementById("file-meta").textContent =
      (file.type || "arquivo") + " - " + (file.size / 1000).toFixed(0) + " KB";
    document.getElementById("dropzone").hidden = true;
    document.getElementById("file-selected").hidden = false;
    document.getElementById("btn-analisar").disabled = false;
  }

  var VERCEL_BLOB_CLIENT_URL = "https://esm.sh/@vercel/blob@2.8.0/client";
  var _blobUploadFn = null;

  /** Carrega (uma unica vez) a funcao upload() do @vercel/blob/client via CDN ESM. */
  async function getBlobUpload() {
    if (!_blobUploadFn) {
      var mod = await import(/* @vite-ignore */ VERCEL_BLOB_CLIENT_URL);
      _blobUploadFn = mod.upload;
    }
    return _blobUploadFn;
  }

  /**
   * Envia o arquivo DIRETO para o Vercel Blob (sem passar pelo corpo de
   * nenhuma Serverless Function - por isso nao ha limite de 4.5 MB aqui).
   * Devolve a URL publica do arquivo, que e o unico dado enviado depois
   * para /api/analisar-documento.
   */
  async function uploadToBlob(file, onProgress) {
    var upload = await getBlobUpload();
    var blob = await upload(file.name, file, {
      access: "public",
      handleUploadUrl: "/api/blob-upload",
      onUploadProgress: onProgress
    });
    return blob.url;
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

  function setStatusPill(kind, text) {
    var el = document.getElementById("status-pill");
    el.className = "status-pill status-pill--" + kind;
    el.textContent = text;
  }

  // ==========================================================================
  // ANALISE (chamada ao backend + pipeline deterministico)
  // ==========================================================================
  async function runAnalysis() {
    if (!state.file) return;

    document.getElementById("btn-analisar").disabled = true;
    document.getElementById("progress-card").hidden = false;
    document.getElementById("result-summary").hidden = true;
    hideUploadError();
    setStatusPill("processing", "Enviando documento...");
    renderProgressSteps(0, -1, null);

    try {
      var blobUrl = await uploadToBlob(state.file, function (progress) {
        setStatusPill("processing", "Enviando documento... " + Math.round(progress.percentage) + "%");
      });
      state.blobUrl = blobUrl;

      renderProgressSteps(1, 0, null); // "lendo documento" ativo enquanto aguarda a IA
      setStatusPill("processing", "Analisando documento...");

      var resp = await fetch("/api/analisar-documento", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: state.file.name,
          mimeType: state.file.type || guessMimeFromName(state.file.name),
          blobUrl: blobUrl
        })
      });

      var json = await resp.json();
      if (!resp.ok || !json.sucesso) {
        throw new Error((json && json.erro) || "Falha ao analisar o documento.");
      }

      renderProgressSteps(3, 2, null);
      await sleep(250);

      normalizeExtraction(json.dados);

      renderProgressSteps(4, 3, null);
      await sleep(200);

      renderProgressSteps(5, 4, null);
      await sleep(200);
      recompute(); // resolve coordenadas, constroi poligono, calcula, valida

      renderProgressSteps(6, 5, null);
      await sleep(150);
      renderProgressSteps(7, 6, null);
      await sleep(150);
      renderProgressSteps(8, 8, null);

      setStatusPill("ok", "Analise concluida");
      renderAll();
      document.getElementById("result-summary").hidden = false;
    } catch (err) {
      var idx = 1;
      renderProgressSteps(null, 0, idx);
      setStatusPill("error", "Falha na analise");
      showUploadError((err && err.message) || "Erro inesperado ao analisar o documento.");
    } finally {
      document.getElementById("btn-analisar").disabled = false;
    }
  }

  function guessMimeFromName(name) {
    var ext = name.split(".").pop().toLowerCase();
    var map = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    return map[ext] || "application/octet-stream";
  }

  /** Normaliza o JSON retornado pela IA para a estrutura de trabalho do app. */
  function normalizeExtraction(dados) {
    state.extraido = dados;
    state.sistema = dados.sistema_coordenadas || { tipo: null, datum: null, epsg: null, zona: null, hemisferio: null };
    state.confrontantes = dados.confrontantes || [];
    state.alertasIA = dados.alertas || [];
    state.vertices = (dados.vertices || []).map(function (v) {
      return {
        id: v.id,
        origem: "EXTRAIDO",
        latitude: v.latitude,
        longitude: v.longitude,
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
  }

  // ==========================================================================
  // PIPELINE GEOESPACIAL DETERMINISTICO (nenhuma linha aqui usa IA)
  // ==========================================================================

  /** Retorna o azimute (graus) do segmento vertice[i] -> vertice[i+1], se disponivel. */
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

  /**
   * Resolve todos os vertices para [lng, lat] WGS84. Primeiro tenta a
   * coordenada absoluta de cada vertice (via sistema de referencia); onde
   * faltar, tenta preencher por CADEIA de azimute/distancia a partir do
   * vertice anterior ja resolvido (secao 19). Vertices preenchidos assim
   * sao marcados como origem = "CALCULADO".
   *
   * Se NENHUM vertice puder ser posicionado de forma absoluta mas houver
   * uma cadeia completa de azimute/distancia, calcula a FORMA RELATIVA da
   * poligonal (secao 20) em um plano local (metros), sem posicionamento
   * geografico - essa geometria nao e desenhada no mapa.
   */
  function reconstructGeometry() {
    var vertices = state.vertices;
    var n = vertices.length;
    var coords = new Array(n).fill(null);
    var origemCalculado = new Array(n).fill(false);

    for (var i = 0; i < n; i++) {
      var ll = IntegralGeometry.resolveVertexLngLat(vertices[i], state.sistema);
      coords[i] = ll;
    }

    // preenchimento por cadeia de azimute/distancia (forward)
    var changed = true;
    var guard = 0;
    while (changed && guard < n * 2) {
      changed = false;
      guard++;
      for (var j = 0; j < n; j++) {
        if (coords[j] != null) continue;
        var prev = (j - 1 + n) % n;
        if (j === 0) continue; // nao fecha o anel automaticamente a partir do ultimo
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
      // tenta reconstrucao RELATIVA (plano local), sem posicionamento geografico
      var rel = new Array(n).fill(null);
      rel[0] = [0, 0];
      var okChain = true;
      for (var k = 0; k < n; k++) {
        var kNext = (k + 1) % n;
        if (kNext === 0) break; // nao fecha automaticamente
        var azK = segmentAzimuth(vertices[k]);
        var distK = vertices[k].distancia_para_proximo;
        if (rel[k] == null || azK == null || distK == null) { okChain = false; break; }
        var rad = (azK * Math.PI) / 180;
        rel[kNext] = [rel[k][0] + Number(distK) * Math.sin(rad), rel[k][1] + Number(distK) * Math.cos(rad)];
      }
      if (okChain && rel.every(function (p) { return p != null; })) {
        semPosicionamentoAbsoluto = true;
        relativeCoordsLngLat = rel;
        missingIndexes.length = 0; // todos "resolvidos", so que sem posicao absoluta
      }
    }

    state.coordsLngLat = coordsLngLat;
    state.resolvedIndexes = resolvedIndexes;
    state.missingIndexes = missingIndexes;
    state.semPosicionamentoAbsoluto = semPosicionamentoAbsoluto;
    state.relativeCoordsLngLat = relativeCoordsLngLat;
  }

  function recompute() {
    reconstructGeometry();

    if (state.semPosicionamentoAbsoluto && state.relativeCoordsLngLat) {
      // area/perimetro no plano local (metros) usando turf com um poligono
      // "sintetico" (as coordenadas relativas ja estao em metros, entao
      // tratamos como se fossem um sistema planar - nao lat/lng real).
      var ring = state.relativeCoordsLngLat.slice();
      ring.push(ring[0]);
      try {
        var localFeature = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
        state.polygonFeature = localFeature;
        state.areaCalculada = Math.abs(shoelaceArea(state.relativeCoordsLngLat));
        state.perimetroCalculado = polylinePerimeterPlanar(state.relativeCoordsLngLat);
      } catch (e) {
        state.polygonFeature = null;
        state.areaCalculada = null;
        state.perimetroCalculado = null;
      }
    } else {
      state.polygonFeature = IntegralGeometry.buildPolygon(state.coordsLngLat);
      state.areaCalculada = IntegralGeometry.calculateAreaM2(state.polygonFeature);
      state.perimetroCalculado = IntegralGeometry.calculatePerimeterM(state.coordsLngLat);
    }

    var areaRegistral = state.extraido && state.extraido.imovel ? state.extraido.imovel.area_registral : null;

    state.validacoes = IntegralGeometry.runValidations({
      vertices: state.vertices,
      sistema: state.sistema,
      coordsLngLat: state.semPosicionamentoAbsoluto ? [] : state.coordsLngLat,
      resolvedIndexes: state.resolvedIndexes,
      missingIndexes: state.semPosicionamentoAbsoluto ? [] : state.missingIndexes,
      polygonFeature: state.semPosicionamentoAbsoluto ? null : state.polygonFeature,
      areaRegistral: areaRegistral,
      areaCalculada: state.areaCalculada,
      perimetroRegistral: null,
      perimetroCalculado: state.perimetroCalculado
    });

    if (state.semPosicionamentoAbsoluto) {
      state.validacoes.unshift({
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

  // ==========================================================================
  // RENDER: RESUMO (secao 32)
  // ==========================================================================
  function renderResultSummary() {
    var el = document.getElementById("result-summary");
    var m = (state.extraido && state.extraido.matricula) || {};
    var sc = state.sistema || {};
    var areaRegistral = state.extraido && state.extraido.imovel ? state.extraido.imovel.area_registral : null;
    var cmp = IntegralGeometry.compareValues(areaRegistral, state.areaCalculada);

    var pior = state.validacoes.reduce(function (acc, v) {
      var rank = { ok: 0, atencao: 1, erro: 2 };
      return rank[v.nivel] > rank[acc] ? v.nivel : acc;
    }, "ok");
    var badgeClass = pior === "ok" ? "rs-badge--ok" : pior === "atencao" ? "rs-badge--warn" : "rs-badge--error";
    var badgeText = pior === "ok" ? "✓ Poligonal valida" : pior === "atencao" ? "⚠ Atencao" : "✕ Erro geometrico";

    var html = "";
    html += '<p class="rs-title">Resultado da analise</p>';
    html += "<h2>" + esc(m.numero ? "Matricula " + m.numero : "Documento analisado") + "</h2>";
    html += '<div class="rs-grid">';
    html += metricBlock("Vertices identificados", state.vertices.length);
    html += metricBlock("Sistema", (sc.datum || "N/D") + (sc.zona ? " · UTM " + sc.zona + (sc.hemisferio || "") : ""));
    html += metricBlock("Area registral", areaRegistral != null ? fmtArea(areaRegistral) : "N/D");
    html += metricBlock(
      "Area calculada",
      state.areaCalculada != null ? fmtArea(state.areaCalculada) : "N/D",
      cmp ? (cmp.diferenca < 0 ? "negative" : "positive") : ""
    );
    if (cmp) {
      html += metricBlock(
        "Diferenca",
        fmtArea(cmp.diferenca) + " (" + cmp.percentual.toFixed(3) + "%)",
        cmp.diferenca < 0 ? "negative" : "positive"
      );
    }
    html += metricBlock("Perimetro calculado", state.perimetroCalculado != null ? fmtLen(state.perimetroCalculado) : "N/D");
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
  // RENDER: DADOS EXTRAIDOS (secoes 21-22)
  // ==========================================================================
  function renderDadosExtraidos() {
    var container = document.getElementById("dados-extraidos-content");
    if (!state.extraido) return;
    var d = state.extraido;
    var m = d.matricula || {};
    var p = d.proprietario || {};
    var im = d.imovel || {};
    var sc = state.sistema || {};

    var html = '<div class="data-grid">';

    html += panel("Matricula", [
      ["Numero", m.numero],
      ["Cartorio", m.cartorio],
      ["Comarca", m.comarca],
      ["Municipio", m.municipio],
      ["UF", m.estado]
    ]);

    html += panel("Proprietario", [
      ["Nome", p.nome],
      ["CPF", p.cpf],
      ["CNPJ", p.cnpj]
    ]);

    html += panel("Imovel", [
      ["Area registral", im.area_registral != null ? fmtArea(im.area_registral, im.unidade_area) : null],
      ["Endereco", im.endereco],
      ["Lote", im.lote],
      ["Quadra", im.quadra]
    ]);

    html += panel("Georreferenciamento", [
      ["Sistema", sc.tipo],
      ["Datum", sc.datum],
      ["EPSG", sc.epsg],
      ["Zona", sc.zona],
      ["Hemisferio", sc.hemisferio],
      ["Numero de vertices", state.vertices.length]
    ]);

    html += "</div>";

    html += '<div class="card evidence-list"><h3>Evidencia textual (auditoria)</h3>';
    if (state.vertices.length === 0) {
      html += '<p class="empty-state-inline">Nenhum vertice identificado.</p>';
    }
    state.vertices.forEach(function (v) {
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

    if (state.alertasIA && state.alertasIA.length) {
      html += '<div class="card"><h3>Alertas da leitura</h3><ul>';
      state.alertasIA.forEach(function (a) { html += "<li>" + esc(a) + "</li>"; });
      html += "</ul></div>";
    }

    container.className = "";
    container.innerHTML = html;
  }

  function panel(title, rows) {
    var html = '<div class="card data-panel"><h3>' + esc(title) + "</h3>";
    rows.forEach(function (r) {
      var label = r[0], value = r[1];
      var isNull = value == null || value === "";
      html +=
        '<div class="field-row"><span class="field-label">' + esc(label) + '</span>' +
        '<span class="field-value' + (isNull ? " is-null" : "") + '">' +
        (isNull ? "nao identificado" : esc(String(value))) +
        "</span></div>";
    });
    html += "</div>";
    return html;
  }

  function confidenceClass(c) {
    if (c >= 0.9) return "confidence-high";
    if (c >= 0.7) return "confidence-medium";
    return "confidence-low";
  }

  // ==========================================================================
  // RENDER: MAPA + TABELA DE VERTICES (secoes 11-12, 26-27)
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
    state.mapLayers.baseMapa = mapaBase;
    state.mapLayers.baseSatelite = sateliteBase;

    document.getElementById("btn-base-mapa").addEventListener("click", function () {
      switchBaseLayer(true);
    });
    document.getElementById("btn-base-satelite").addEventListener("click", function () {
      switchBaseLayer(false);
    });
    document.getElementById("btn-zoom-in").addEventListener("click", function () { state.map.zoomIn(); });
    document.getElementById("btn-zoom-out").addEventListener("click", function () { state.map.zoomOut(); });
    document.getElementById("btn-fit").addEventListener("click", function () { fitMapToPolygon(); });
  }

  function switchBaseLayer(useMapa) {
    var m = state.mapLayers;
    if (useMapa) {
      state.map.removeLayer(m.baseSatelite);
      m.baseMapa.addTo(state.map);
    } else {
      state.map.removeLayer(m.baseMapa);
      m.baseSatelite.addTo(state.map);
    }
    document.getElementById("btn-base-mapa").classList.toggle("chip--active", useMapa);
    document.getElementById("btn-base-satelite").classList.toggle("chip--active", !useMapa);
  }

  function fitMapToPolygon() {
    if (state.mapLayers.polygon) {
      state.map.fitBounds(state.mapLayers.polygon.getBounds(), { padding: [30, 30] });
    }
  }

  function renderMap() {
    document.getElementById("mapa-empty").hidden = true;
    document.getElementById("mapa-content").hidden = false;

    if (!state.map) initMap();

    var m = state.mapLayers;
    if (m.polygon) { state.map.removeLayer(m.polygon); m.polygon = null; }
    if (m.vertices) { state.map.removeLayer(m.vertices); m.vertices = null; }

    var mapCard = document.querySelector(".map-card");
    if (state.semPosicionamentoAbsoluto) {
      mapCard.style.display = "none";
      var warn = document.getElementById("mapa-sem-posicionamento");
      if (!warn) {
        warn = document.createElement("div");
        warn.id = "mapa-sem-posicionamento";
        warn.className = "card";
        document.getElementById("mapa-content").insertBefore(warn, document.getElementById("mapa-content").firstChild);
      }
      warn.innerHTML =
        "<h3>Mapa indisponivel</h3><p>Poligonal reconstruida sem posicionamento geografico absoluto (apenas rumos/azimutes/distancias, sem coordenada inicial georreferenciada). A forma e as medidas estao disponiveis na tabela de vertices, mas nao sao exibidas no mapa para evitar posicionamento incorreto.</p>";
      return;
    } else {
      mapCard.style.display = "";
      var existingWarn = document.getElementById("mapa-sem-posicionamento");
      if (existingWarn) existingWarn.remove();
    }

    if (!state.coordsLngLat || state.coordsLngLat.length < 3) return;

    var latlngs = state.coordsLngLat.map(function (c) { return [c[1], c[0]]; });
    var polygon = L.polygon(latlngs, { color: "#1d4ed8", weight: 2.5, fillColor: "#1d4ed8", fillOpacity: 0.12 }).addTo(state.map);
    m.polygon = polygon;

    var markersGroup = L.layerGroup();
    state.resolvedIndexes.forEach(function (vIdx, orderIdx) {
      var vertex = state.vertices[vIdx];
      var coord = state.coordsLngLat[orderIdx];
      var marker = L.circleMarker([coord[1], coord[0]], {
        radius: 6,
        color: "#ffffff",
        weight: 2,
        fillColor: "#1d4ed8",
        fillOpacity: 1
      });
      var dist = vertex.distancia_para_proximo != null ? fmtLen(vertex.distancia_para_proximo) : "N/D";
      var az = vertex.azimute_para_proximo || "N/D";
      var conf = vertex.confrontante_para_proximo || "N/D";
      marker.bindPopup(
        "<b>" + esc(vertex.id) + "</b><br/>" +
        "Lng/Lat: " + coord[0].toFixed(6) + ", " + coord[1].toFixed(6) + "<br/>" +
        "Distancia ao proximo: " + dist + "<br/>" +
        "Azimute: " + esc(az) + "<br/>" +
        "Confrontante: " + esc(conf)
      );
      marker.bindTooltip(vertex.id, { permanent: true, direction: "top", className: "vertex-label", offset: [0, -6] });
      markersGroup.addLayer(marker);
    });
    markersGroup.addTo(state.map);
    m.vertices = markersGroup;

    fitMapToPolygon();
  }

  function renderTabelaVertices() {
    var tbody = document.getElementById("tabela-vertices-body");
    tbody.innerHTML = "";

    var usaUTM = state.sistema && state.sistema.tipo === "UTM";

    state.vertices.forEach(function (v, idx) {
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
        var idx = parseInt(btn.dataset.idx, 10);
        state.vertices.splice(idx, 1);
        recompute();
        renderAll();
      });
    });
  }

  function onVertexFieldChange(e) {
    var idx = parseInt(e.target.dataset.idx, 10);
    var field = e.target.dataset.field;
    var vertex = state.vertices[idx];
    if (!vertex) return;

    var usaUTM = state.sistema && state.sistema.tipo === "UTM";
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

    recompute();
    renderAll();
  }

  function renderConfrontantes() {
    var el = document.getElementById("lista-confrontantes");
    if (!state.confrontantes || state.confrontantes.length === 0) {
      el.innerHTML = '<p class="empty-state-inline">Nenhum confrontante identificado.</p>';
      return;
    }
    var html = '<div class="table-scroll"><table class="data-table"><thead><tr>' +
      "<th>De</th><th>Ate</th><th>Nome</th><th>Tipo</th><th>Distancia</th><th>Azimute</th>" +
      "</tr></thead><tbody>";
    state.confrontantes.forEach(function (c) {
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
      var nextNum = state.vertices.length + 1;
      state.vertices.push({
        id: "V" + String(nextNum).padStart(2, "0"),
        origem: "EDITADO",
        latitude: null,
        longitude: null,
        easting: null,
        northing: null,
        distancia_para_proximo: null,
        azimute_para_proximo: null,
        rumo_para_proximo: null,
        confrontante_para_proximo: null,
        texto_origem: null,
        confianca: 0
      });
      recompute();
      renderAll();
    });
  }

  // ==========================================================================
  // RENDER: VALIDACAO (secoes 15-16)
  // ==========================================================================
  function renderValidacao() {
    var container = document.getElementById("validacao-content");
    if (!state.extraido) return;

    var all = state.validacoes.slice();
    (state.alertasIA || []).forEach(function (msg) {
      all.push({ nivel: "atencao", codigo: "ALERTA_LEITURA", mensagem: msg });
    });

    var icon = { ok: "✓", atencao: "⚠", erro: "✕" };
    var html = '<div class="validation-list">';
    all.forEach(function (v) {
      html +=
        '<div class="validation-item validation-item--' + v.nivel + '">' +
        '<span class="v-icon">' + icon[v.nivel] + "</span>" +
        "<span>" + esc(v.mensagem) + "</span>" +
        "</div>";
    });
    html += "</div>";
    container.className = "";
    container.innerHTML = html;
  }

  // ==========================================================================
  // RENDER: EXPORTACAO (secoes 23-25)
  // ==========================================================================
  function buildExportData() {
    return {
      matricula: state.extraido.matricula,
      proprietario: state.extraido.proprietario,
      sistemaCoordenadas: state.sistema,
      areaRegistral: state.extraido.imovel ? state.extraido.imovel.area_registral : null,
      areaCalculada: state.areaCalculada,
      perimetroCalculado: state.perimetroCalculado,
      vertices: state.vertices,
      coordsLngLat: state.coordsLngLat,
      alertas: state.validacoes
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

  function initExportButtons() {
    document.getElementById("btn-export-geojson").addEventListener("click", function () {
      if (state.semPosicionamentoAbsoluto) return alert("Exportacao indisponivel: poligonal sem posicionamento geografico absoluto.");
      var geojson = IntegralExport.toGeoJSON(buildExportData());
      downloadBlob(JSON.stringify(geojson, null, 2), fileBaseName() + ".geojson", "application/geo+json");
    });
    document.getElementById("btn-export-kml").addEventListener("click", function () {
      if (state.semPosicionamentoAbsoluto) return alert("Exportacao indisponivel: poligonal sem posicionamento geografico absoluto.");
      var kml = IntegralExport.toKML(buildExportData());
      downloadBlob(kml, fileBaseName() + ".kml", "application/vnd.google-earth.kml+xml");
    });
    document.getElementById("btn-export-csv").addEventListener("click", function () {
      var csv = IntegralExport.toCSV(buildExportData());
      downloadBlob(csv, fileBaseName() + ".csv", "text/csv;charset=utf-8");
    });
    document.getElementById("btn-export-txt").addEventListener("click", function () {
      var txt = IntegralExport.toTXT(buildExportData());
      downloadBlob(txt, fileBaseName() + ".txt", "text/plain;charset=utf-8");
    });
  }

  function fileBaseName() {
    var num = state.extraido && state.extraido.matricula ? state.extraido.matricula.numero : null;
    return "integral-geo-matricula-" + (num || "documento").toString().replace(/[^a-z0-9]+/gi, "-");
  }

  function renderExportacao() {
    document.getElementById("exportacao-empty").hidden = true;
    document.getElementById("exportacao-content").hidden = false;
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

  function renderAll() {
    renderResultSummary();
    renderDadosExtraidos();
    renderTabelaVertices();
    renderConfrontantes();
    renderMap();
    renderValidacao();
    renderExportacao();
  }

  // ==========================================================================
  // BOOT
  // ==========================================================================
  document.addEventListener("DOMContentLoaded", function () {
    initNav();
    initUpload();
    initTableActions();
    initExportButtons();
  });

  window.IntegralApp = { goToView: goToView };
})();
