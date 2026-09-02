/**
 * offline-app/public/app.js
 * ---------------------------------------------------------------------------
 * Editor de polígonos da versão OFFLINE do protótipo "Ortofoto -> divisão de
 * lotes". A logica do editor SVG (arrastar vertice, inserir/remover ponto,
 * desenho manual, calibracao por 2 pontos, exportacao) e a MESMA do
 * leitor-de-matriculas hospedado na Vercel (app.js, secao "ORTOFOTO"),
 * portada aqui sem mudanca de comportamento.
 *
 * O que muda nesta versao:
 *   - Nao ha upload de arquivo nem decodificacao no navegador (sem
 *     geotiff.js, sem canvas gigante). O usuario aponta um caminho no disco;
 *     o servidor local (server.js) le o arquivo, reduz a resolucao com
 *     "sharp" (streaming, sem materializar o arquivo inteiro em memoria) e
 *     devolve uma imagem ja pequena, pronta para exibir.
 *   - "Detectar divisas com IA" reenvia so o caminho ao servidor, que gera
 *     uma copia (separada, menor) so para a chamada a IA e a descarta em
 *     seguida - nada fica salvo no servidor local entre uma chamada e outra.
 *   - Toda a matematica (area, geocalibracao, exportacao) continua rodando
 *     aqui no navegador, via lib/ortofoto.js - identico ao app.js principal.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  var CORES = ["#1d4ed8", "#0d9488", "#b7791f", "#c0362c", "#7c3aed", "#0891b2", "#65a30d", "#db2777"];
  var SVGNS = "http://www.w3.org/2000/svg";

  var state = {
    caminho: null,
    nomeArquivo: null,
    imagemDataUrl: null,
    larguraNatural: 0,
    alturaNatural: 0,
    status: "idle", // idle | carregando | analisando | pronto | erro
    statusMsg: "",
    observacoesGerais: null,
    alertasIA: [],
    poligonos: [], // [{id, rotulo, vertices:[{x,y}], evidencias:[], confianca, editadoManualmente}]
    poligonoSelecionadoId: null,
    modoDesenho: false,
    desenhoVertices: [],
    calibracao: [null, null],
    aguardandoCliquePara: null,
    transform: null,
    arrastando: null,
    _suprimirProximoClick: false
  };

  var navegadorPastaAtual = null;

  function novoId() { return "og" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function clampNum(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }
  function esc(str) {
    if (str == null) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  function formatarBytes(n) {
    if (n == null) return "";
    if (n > 1e9) return (n / 1e9).toFixed(2) + " GB";
    if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
    if (n > 1e3) return (n / 1e3).toFixed(0) + " KB";
    return n + " B";
  }

  function mostrarErroSelecao(msg) {
    var el = document.getElementById("mensagem-erro-selecao");
    el.hidden = false;
    el.textContent = msg;
  }
  function ocultarErroSelecao() {
    var el = document.getElementById("mensagem-erro-selecao");
    el.hidden = true;
    el.textContent = "";
  }

  function resetarEstado() {
    state.caminho = null;
    state.nomeArquivo = null;
    state.imagemDataUrl = null;
    state.larguraNatural = 0;
    state.alturaNatural = 0;
    state.status = "idle";
    state.statusMsg = "";
    state.observacoesGerais = null;
    state.alertasIA = [];
    state.poligonos = [];
    state.poligonoSelecionadoId = null;
    state.modoDesenho = false;
    state.desenhoVertices = [];
    state.calibracao = [null, null];
    state.aguardandoCliquePara = null;
    state.transform = null;
    state.arrastando = null;
  }

  // -------------------------------------------------------------------
  // Navegador de pastas
  // -------------------------------------------------------------------
  function initNavegador() {
    var btnAlternar = document.getElementById("btn-alternar-navegador");
    var painel = document.getElementById("navegador-pastas");
    btnAlternar.addEventListener("click", function () {
      painel.hidden = !painel.hidden;
      if (!painel.hidden && !navegadorPastaAtual) {
        fetch("/api/atalhos").then(function (r) { return r.json(); }).then(function (json) {
          renderAtalhos(json.atalhos || []);
          navegarPara(json.home);
        });
      }
    });
  }

  function renderAtalhos(atalhos) {
    var wrap = document.getElementById("navegador-atalhos");
    wrap.innerHTML = "";
    atalhos.forEach(function (a) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = a.rotulo;
      btn.addEventListener("click", function () { navegarPara(a.caminho); });
      wrap.appendChild(btn);
    });
  }

  function navegarPara(caminho) {
    fetch("/api/listar?caminho=" + encodeURIComponent(caminho))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
      .then(function (res) {
        if (!res.ok) { mostrarErroSelecao(res.json.erro || "Não foi possível abrir esta pasta."); return; }
        navegadorPastaAtual = res.json.caminho;
        renderListaNavegador(res.json);
      })
      .catch(function () { mostrarErroSelecao("Não foi possível abrir esta pasta."); });
  }

  function renderListaNavegador(dados) {
    document.getElementById("navegador-caminho-atual").textContent = dados.caminho;
    var lista = document.getElementById("navegador-lista");
    lista.innerHTML = "";

    if (dados.pai) {
      var subir = document.createElement("div");
      subir.className = "item-navegador pasta";
      subir.textContent = "⬆️  ..";
      subir.addEventListener("click", function () { navegarPara(dados.pai); });
      lista.appendChild(subir);
    }
    dados.pastas.forEach(function (p) {
      var item = document.createElement("div");
      item.className = "item-navegador pasta";
      item.textContent = "📁  " + p.nome;
      item.addEventListener("click", function () { navegarPara(p.caminho); });
      lista.appendChild(item);
    });
    dados.arquivos.forEach(function (f) {
      var item = document.createElement("div");
      item.className = "item-navegador";
      item.innerHTML = "🖼️  " + esc(f.nome) + '<span class="tam">' + esc(formatarBytes(f.tamanho)) + "</span>";
      item.addEventListener("click", function () {
        document.getElementById("input-caminho").value = f.caminho;
        document.getElementById("navegador-pastas").hidden = true;
      });
      lista.appendChild(item);
    });
    if (!dados.pastas.length && !dados.arquivos.length) {
      var vazio = document.createElement("div");
      vazio.className = "empty-inline";
      vazio.textContent = "Pasta vazia (ou sem imagens compatíveis).";
      lista.appendChild(vazio);
    }
  }

  // -------------------------------------------------------------------
  // Carregar imagem
  // -------------------------------------------------------------------
  function initSelecao() {
    document.getElementById("btn-carregar").addEventListener("click", carregarImagem);
    document.getElementById("input-caminho").addEventListener("keydown", function (e) {
      if (e.key === "Enter") carregarImagem();
    });
    document.getElementById("btn-trocar-imagem").addEventListener("click", function () {
      if (state.poligonos.length && !window.confirm("Trocar de imagem descarta os polígonos propostos/editados atuais (nada é salvo automaticamente). Continuar?")) return;
      resetarEstado();
      document.getElementById("input-caminho").value = "";
      renderTudo();
    });
  }

  function carregarImagem() {
    ocultarErroSelecao();
    var caminho = document.getElementById("input-caminho").value.trim();
    if (!caminho) return mostrarErroSelecao("Informe o caminho completo do arquivo.");

    resetarEstado();
    state.caminho = caminho;
    state.status = "carregando";
    state.statusMsg = "Lendo e reduzindo a imagem no disco local (pode levar alguns segundos em arquivos grandes)...";
    renderTudo();

    fetch("/api/carregar-imagem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caminho: caminho })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.json.erro || "Falha ao carregar a imagem.");
        state.nomeArquivo = res.json.nomeArquivo;
        state.imagemDataUrl = res.json.dataUrl;
        state.larguraNatural = res.json.largura;
        state.alturaNatural = res.json.altura;
        state.status = "pronto";
        state.statusMsg = "Imagem original: " + formatarBytes(res.json.tamanhoOriginalBytes) +
          " · exibindo cópia reduzida (" + res.json.largura + "×" + res.json.altura + "px).";
      })
      .catch(function (err) {
        state.status = "erro";
        mostrarErroSelecao(err.message || "Falha ao carregar a imagem.");
        state.caminho = null;
      })
      .finally(renderTudo);
  }

  // -------------------------------------------------------------------
  // Render geral
  // -------------------------------------------------------------------
  function renderTudo() {
    var vazio = document.getElementById("secao-vazio");
    var viewer = document.getElementById("secao-viewer");
    if (!state.imagemDataUrl) {
      vazio.hidden = false;
      viewer.hidden = true;
      var textoVazio = "Nenhuma imagem carregada ainda.";
      if (state.status === "carregando") textoVazio = state.statusMsg;
      document.getElementById("estado-vazio-texto").textContent = textoVazio;
      return;
    }
    vazio.hidden = true;
    viewer.hidden = false;

    var img = document.getElementById("ortofoto-img");
    if (img.getAttribute("src") !== state.imagemDataUrl) img.src = state.imagemDataUrl;

    var svg = document.getElementById("ortofoto-svg");
    svg.setAttribute("viewBox", "0 0 " + (state.larguraNatural || 1) + " " + (state.alturaNatural || 1));

    document.getElementById("status-texto").textContent = state.statusMsg || "";
    document.getElementById("btn-detectar").disabled = state.status === "analisando" || state.status === "carregando";

    renderSVG();
    renderCalibracao();
    renderListaPoligonos();
    atualizarBotaoExportGeoJSON();
  }

  function pixelFromEvent(evt) {
    var svg = document.getElementById("ortofoto-svg");
    var rect = svg.getBoundingClientRect();
    var scaleX = rect.width ? state.larguraNatural / rect.width : 1;
    var scaleY = rect.height ? state.alturaNatural / rect.height : 1;
    var clientX = (evt.touches && evt.touches[0]) ? evt.touches[0].clientX : evt.clientX;
    var clientY = (evt.touches && evt.touches[0]) ? evt.touches[0].clientY : evt.clientY;
    return {
      x: clampNum((clientX - rect.left) * scaleX, 0, state.larguraNatural),
      y: clampNum((clientY - rect.top) * scaleY, 0, state.alturaNatural)
    };
  }

  function renderSVG() {
    var svg = document.getElementById("ortofoto-svg");
    if (!svg) return;
    svg.innerHTML = "";
    var raioVertice = Math.max(6, state.larguraNatural * 0.005);
    var raioMedio = Math.max(5, state.larguraNatural * 0.0038);
    var fonte = Math.max(14, state.larguraNatural * 0.014);

    state.poligonos.forEach(function (poly, pi) {
      var cor = CORES[pi % CORES.length];
      var selecionado = poly.id === state.poligonoSelecionadoId;

      var polygonEl = svgEl("polygon", {
        points: poly.vertices.map(function (v) { return v.x + "," + v.y; }).join(" "),
        fill: cor,
        "fill-opacity": selecionado ? "0.30" : "0.15",
        stroke: cor,
        "stroke-width": selecionado ? "3.5" : "2.5"
      });
      polygonEl.style.cursor = "pointer";
      polygonEl.addEventListener("click", function (e) {
        e.stopPropagation();
        state.poligonoSelecionadoId = (state.poligonoSelecionadoId === poly.id) ? null : poly.id;
        renderSVG();
        renderListaPoligonos();
      });
      svg.appendChild(polygonEl);

      if (poly.vertices[0]) {
        var label = svgEl("text", {
          x: poly.vertices[0].x, y: Math.max(fonte, poly.vertices[0].y - 10),
          fill: cor, "font-size": fonte, "font-weight": "700", "font-family": "Inter, sans-serif",
          "paint-order": "stroke", stroke: "#fff", "stroke-width": "3"
        });
        label.textContent = poly.rotulo || "";
        svg.appendChild(label);
      }

      for (var i = 0; i < poly.vertices.length; i++) {
        var a = poly.vertices[i];
        var b = poly.vertices[(i + 1) % poly.vertices.length];
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        var mid = svgEl("rect", {
          x: mx - raioMedio, y: my - raioMedio, width: raioMedio * 2, height: raioMedio * 2,
          transform: "rotate(45 " + mx + " " + my + ")",
          fill: "#fff", stroke: cor, "stroke-width": "2", "fill-opacity": "0.9"
        });
        mid.style.cursor = "copy";
        (function (polyRef, idx, midX, midY) {
          mid.addEventListener("click", function (e) {
            e.stopPropagation();
            polyRef.vertices.splice(idx + 1, 0, { x: midX, y: midY });
            polyRef.editadoManualmente = true;
            renderSVG();
            renderListaPoligonos();
          });
        })(poly, i, mx, my);
        svg.appendChild(mid);
      }

      poly.vertices.forEach(function (v, vi) {
        var circ = svgEl("circle", { cx: v.x, cy: v.y, r: raioVertice, fill: cor, stroke: "#fff", "stroke-width": "2" });
        circ.style.cursor = "grab";
        circ.addEventListener("pointerdown", function (e) {
          if (e.button != null && e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          state.arrastando = { tipo: "vertice", polyId: poly.id, verticeIndex: vi };
          try { circ.setPointerCapture(e.pointerId); } catch (err) {}
        });
        circ.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (poly.vertices.length <= 3) { alert("Um polígono precisa de pelo menos 3 vértices."); return; }
          poly.vertices.splice(vi, 1);
          poly.editadoManualmente = true;
          renderSVG();
          renderListaPoligonos();
        });
        svg.appendChild(circ);
      });
    });

    if (state.modoDesenho && state.desenhoVertices.length) {
      if (state.desenhoVertices.length >= 2) {
        svg.appendChild(svgEl("polyline", {
          points: state.desenhoVertices.map(function (v) { return v.x + "," + v.y; }).join(" "),
          fill: "none", stroke: "#1d4ed8", "stroke-width": "2.5", "stroke-dasharray": "6 4"
        }));
      }
      state.desenhoVertices.forEach(function (v, i) {
        var c = svgEl("circle", { cx: v.x, cy: v.y, r: raioVertice, fill: "#1d4ed8", stroke: "#fff", "stroke-width": "2" });
        if (i === 0 && state.desenhoVertices.length >= 3) {
          c.style.cursor = "pointer";
          c.addEventListener("click", function (e) { e.stopPropagation(); concluirDesenho(); });
        }
        svg.appendChild(c);
      });
    }

    state.calibracao.forEach(function (cal, idx) {
      if (!cal || cal.px == null) return;
      var g = svgEl("g", {});
      var c = svgEl("circle", { cx: cal.px, cy: cal.py, r: raioVertice + 1, fill: "#c0362c", stroke: "#fff", "stroke-width": "2" });
      c.style.cursor = "grab";
      c.addEventListener("pointerdown", function (e) {
        if (e.button != null && e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        state.arrastando = { tipo: "calibracao", indice: idx };
        try { c.setPointerCapture(e.pointerId); } catch (err) {}
      });
      var t = svgEl("text", {
        x: cal.px + raioVertice + 6, y: cal.py - raioVertice,
        fill: "#c0362c", "font-size": fonte, "font-weight": "700",
        "paint-order": "stroke", stroke: "#fff", "stroke-width": "3"
      });
      t.textContent = "C" + (idx + 1);
      g.appendChild(c);
      g.appendChild(t);
      svg.appendChild(g);
    });

    svg.onclick = function (e) {
      if (state._suprimirProximoClick) { state._suprimirProximoClick = false; return; }
      var pt = pixelFromEvent(e);
      if (state.aguardandoCliquePara != null) {
        var idx = state.aguardandoCliquePara;
        state.calibracao[idx] = state.calibracao[idx] || {};
        state.calibracao[idx].px = pt.x;
        state.calibracao[idx].py = pt.y;
        state.aguardandoCliquePara = null;
        recalcularTransform();
        renderSVG();
        renderCalibracao();
        document.getElementById("status-texto").textContent = state.statusMsg || "";
        return;
      }
      if (state.modoDesenho) {
        state.desenhoVertices.push(pt);
        renderSVG();
      }
    };

    svg.onpointermove = function (e) {
      if (!state.arrastando) return;
      var pt = pixelFromEvent(e);
      if (state.arrastando.tipo === "vertice") {
        var poly = state.poligonos.filter(function (p) { return p.id === state.arrastando.polyId; })[0];
        if (!poly) return;
        poly.vertices[state.arrastando.verticeIndex] = pt;
        poly.editadoManualmente = true;
      } else if (state.arrastando.tipo === "calibracao") {
        var cal = state.calibracao[state.arrastando.indice];
        if (!cal) return;
        cal.px = pt.x; cal.py = pt.y;
        recalcularTransform();
      }
      renderSVG();
    };
    svg.onpointerup = function () {
      var eraVertice = state.arrastando && state.arrastando.tipo === "vertice";
      var eraCalib = state.arrastando && state.arrastando.tipo === "calibracao";
      if (eraVertice || eraCalib) state._suprimirProximoClick = true;
      state.arrastando = null;
      if (eraVertice) renderListaPoligonos();
      if (eraCalib) renderCalibracao();
    };
    svg.onpointerleave = function () { state.arrastando = null; };
  }

  function initDesenho() {
    document.getElementById("btn-novo-poligono").addEventListener("click", function () {
      state.modoDesenho = true;
      state.desenhoVertices = [];
      document.getElementById("dica-desenho").hidden = false;
      document.getElementById("acoes-desenho").hidden = false;
      renderSVG();
    });
    document.getElementById("btn-cancelar-desenho").addEventListener("click", cancelarDesenho);
    document.getElementById("btn-concluir-desenho").addEventListener("click", concluirDesenho);
  }

  function cancelarDesenho() {
    state.modoDesenho = false;
    state.desenhoVertices = [];
    document.getElementById("dica-desenho").hidden = true;
    document.getElementById("acoes-desenho").hidden = true;
    renderSVG();
  }

  function concluirDesenho() {
    var verts = state.desenhoVertices;
    if (verts.length < 3) { alert("Desenhe pelo menos 3 pontos para formar um polígono."); return; }
    state.poligonos.push({
      id: novoId(),
      rotulo: "Lote manual " + (state.poligonos.length + 1),
      vertices: verts.slice(),
      evidencias: ["Desenhado manualmente pelo usuário."],
      confianca: 1,
      editadoManualmente: true
    });
    cancelarDesenho();
    renderListaPoligonos();
    atualizarBotaoExportGeoJSON();
  }

  // -------------------------------------------------------------------
  // Calibração geográfica
  // -------------------------------------------------------------------
  function recalcularTransform() {
    var pontos = state.calibracao.filter(function (c) {
      return c && c.px != null && c.py != null && isFinite(c.lat) && isFinite(c.lng);
    });
    state.transform = pontos.length === 2 ? window.IntegralOrtofoto.calibrarTransformacao(pontos) : null;
    atualizarBotaoExportGeoJSON();
  }

  function atualizarBotaoExportGeoJSON() {
    var btn = document.getElementById("btn-export-geojson");
    if (!btn) return;
    btn.disabled = !state.transform || !state.poligonos.length;
  }

  function renderCalibracao() {
    var wrap = document.getElementById("lista-calibracao");
    if (!wrap) return;
    var html = "";
    for (var i = 0; i < 2; i++) {
      var cal = state.calibracao[i];
      html += '<div class="calib-item">';
      html += '<span class="calib-titulo">Ponto C' + (i + 1) + "</span>";
      html += '<button class="btn btn-secundario btn-sm" data-marcar-calib="' + i + '" type="button">' +
        (cal && cal.px != null ? "Remarcar na imagem" : "Marcar na imagem") + "</button>";
      html += '<label class="calib-campo"><span>Latitude</span><input type="text" inputmode="decimal" placeholder="ex: -26.337412" data-calib-lat="' + i + '" value="' + (cal && cal.lat != null ? cal.lat : "") + '" /></label>';
      html += '<label class="calib-campo"><span>Longitude</span><input type="text" inputmode="decimal" placeholder="ex: -49.123456" data-calib-lng="' + i + '" value="' + (cal && cal.lng != null ? cal.lng : "") + '" /></label>';
      html += '<span class="calib-pixel">' + (cal && cal.px != null ? "pixel (" + Math.round(cal.px) + ", " + Math.round(cal.py) + ")" : "posição não marcada") + "</span>";
      html += "</div>";
    }
    if (state.transform) {
      html += '<p class="calib-ok">✓ Calibração ativa · escala aproximada: ' + state.transform.escalaMetrosPorPixel.toFixed(4) + " m/pixel (georreferenciamento aproximado - conferir com levantamento antes de uso oficial).</p>";
    } else {
      html += '<p class="calib-pendente">Marque os 2 pontos na imagem e informe latitude/longitude de cada um para ativar a exportação georreferenciada.</p>';
    }
    wrap.innerHTML = html;

    wrap.querySelectorAll("[data-marcar-calib]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.aguardandoCliquePara = parseInt(btn.dataset.marcarCalib, 10);
        document.getElementById("status-texto").textContent = "Clique na imagem para marcar o ponto C" + (state.aguardandoCliquePara + 1) + "...";
      });
    });
    wrap.querySelectorAll("[data-calib-lat]").forEach(function (input) {
      input.addEventListener("change", function () {
        var idx = parseInt(input.dataset.calibLat, 10);
        state.calibracao[idx] = state.calibracao[idx] || {};
        state.calibracao[idx].lat = parseFloat(String(input.value).replace(",", "."));
        recalcularTransform();
        renderCalibracao();
      });
    });
    wrap.querySelectorAll("[data-calib-lng]").forEach(function (input) {
      input.addEventListener("change", function () {
        var idx = parseInt(input.dataset.calibLng, 10);
        state.calibracao[idx] = state.calibracao[idx] || {};
        state.calibracao[idx].lng = parseFloat(String(input.value).replace(",", "."));
        recalcularTransform();
        renderCalibracao();
      });
    });
  }

  // -------------------------------------------------------------------
  // Detectar divisas com IA
  // -------------------------------------------------------------------
  function initDetectar() {
    document.getElementById("btn-detectar").addEventListener("click", detectarDivisas);
  }

  function detectarDivisas() {
    if (!state.caminho || state.status === "analisando" || state.status === "carregando") return;

    state.status = "analisando";
    state.statusMsg = "Reduzindo imagem para análise e consultando a IA (pode levar até 1-2 minutos em arquivos grandes)...";
    document.getElementById("status-texto").textContent = state.statusMsg;
    document.getElementById("btn-detectar").disabled = true;

    fetch("/api/analisar-ortofoto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caminho: state.caminho })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.json.erro || "Falha ao analisar a ortofoto.");
        var dados = res.json.dados;
        var novosPoligonos = (dados.poligonos || [])
          .map(function (p, idx) {
            return {
              id: novoId(),
              rotulo: p.rotulo || ("Lote " + (state.poligonos.length + idx + 1)),
              vertices: (p.vertices || []).map(function (v) {
                return { x: clampNum(v.x, 0, 1) * state.larguraNatural, y: clampNum(v.y, 0, 1) * state.alturaNatural };
              }),
              evidencias: p.evidencias || [],
              confianca: p.confianca != null ? p.confianca : null,
              editadoManualmente: false
            };
          })
          .filter(function (p) { return p.vertices.length >= 3; });

        state.poligonos = state.poligonos.concat(novosPoligonos);
        state.observacoesGerais = dados.observacoes_gerais || null;
        state.alertasIA = dados.alertas || [];
        state.status = "pronto";
        state.statusMsg = novosPoligonos.length
          ? novosPoligonos.length + " polígono(s) proposto(s) - confira e ajuste antes de exportar."
          : "Nenhuma divisa clara identificada nesta imagem.";
      })
      .catch(function (err) {
        state.status = "erro";
        state.statusMsg = err.message || "Falha ao detectar divisas.";
      })
      .finally(function () {
        document.getElementById("btn-detectar").disabled = false;
        renderTudo();
      });
  }

  // -------------------------------------------------------------------
  // Lista de polígonos
  // -------------------------------------------------------------------
  function renderListaPoligonos() {
    var wrap = document.getElementById("lista-poligonos");
    if (!wrap) return;

    var htmlExtra = "";
    if (state.alertasIA && state.alertasIA.length) {
      htmlExtra += '<div class="alertas-ia">' + state.alertasIA.map(function (a) { return "<p>⚠ " + esc(a) + "</p>"; }).join("") + "</div>";
    }
    if (state.observacoesGerais) {
      htmlExtra += '<p class="obs-gerais">' + esc(state.observacoesGerais) + "</p>";
    }

    if (!state.poligonos.length) {
      wrap.innerHTML = htmlExtra + '<div class="empty-inline">Nenhum polígono ainda. Use "Detectar divisas com IA" ou desenhe manualmente.</div>';
      return;
    }

    var rows = state.poligonos.map(function (poly, i) {
      var areaPx = window.IntegralOrtofoto.areaShoelacePx(poly.vertices);
      var areaTexto;
      if (state.transform) {
        var areaM2 = areaPx * Math.pow(state.transform.escalaMetrosPorPixel, 2);
        poly._areaM2 = areaM2;
        areaTexto = areaM2.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " m² (aprox.)";
      } else {
        poly._areaM2 = null;
        areaTexto = Math.round(areaPx).toLocaleString("pt-BR") + " px²";
      }
      var cor = CORES[i % CORES.length];
      var confTexto = poly.confianca != null ? Math.round(poly.confianca * 100) + "%" : "—";
      var evidenciasHtml = (poly.evidencias || []).map(function (ev) { return "<li>" + esc(ev) + "</li>"; }).join("");

      return (
        '<div class="poligono-card' + (poly.id === state.poligonoSelecionadoId ? " poligono-card--selecionado" : "") + '" data-poly-row="' + poly.id + '">' +
          '<div class="poligono-cabecalho">' +
            '<span class="poligono-cor" style="background:' + cor + '"></span>' +
            '<input type="text" class="poligono-rotulo" value="' + esc(poly.rotulo) + '" data-poly-rotulo="' + poly.id + '" />' +
            (poly.editadoManualmente ? '<span class="tag-editado">editado</span>' : "") +
            '<button class="remover-poligono" type="button" data-poly-remover="' + poly.id + '">Remover</button>' +
          "</div>" +
          '<div class="poligono-metricas">' +
            "<span><strong>" + poly.vertices.length + "</strong> vértices</span>" +
            "<span><strong>" + areaTexto + "</strong></span>" +
            "<span>Confiança da IA: <strong>" + confTexto + "</strong></span>" +
          "</div>" +
          (evidenciasHtml ? '<ul class="poligono-evidencias">' + evidenciasHtml + "</ul>" : "") +
        "</div>"
      );
    }).join("");

    wrap.innerHTML = htmlExtra + rows;

    wrap.querySelectorAll("[data-poly-row]").forEach(function (card) {
      card.addEventListener("click", function (e) {
        if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
        var id = card.dataset.polyRow;
        state.poligonoSelecionadoId = (state.poligonoSelecionadoId === id) ? null : id;
        renderSVG();
        renderListaPoligonos();
      });
    });
    wrap.querySelectorAll("[data-poly-rotulo]").forEach(function (input) {
      input.addEventListener("change", function () {
        var poly = state.poligonos.filter(function (p) { return p.id === input.dataset.polyRotulo; })[0];
        if (poly) poly.rotulo = input.value.trim() || poly.rotulo;
        renderSVG();
      });
    });
    wrap.querySelectorAll("[data-poly-remover]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        state.poligonos = state.poligonos.filter(function (p) { return p.id !== btn.dataset.polyRemover; });
        if (state.poligonoSelecionadoId === btn.dataset.polyRemover) state.poligonoSelecionadoId = null;
        renderSVG();
        renderListaPoligonos();
      });
    });

    atualizarBotaoExportGeoJSON();
  }

  // -------------------------------------------------------------------
  // Exportação
  // -------------------------------------------------------------------
  function nomeBase() {
    var nome = (state.nomeArquivo || "ortofoto").replace(/\.[^.]+$/, "");
    return "integral-ortofoto-" + nome.replace(/[^a-z0-9]+/gi, "-");
  }

  function exportarGeoJSON() {
    if (!state.transform || !state.poligonos.length) return;
    state.poligonos.forEach(function (p) {
      p._areaM2 = window.IntegralOrtofoto.areaShoelacePx(p.vertices) * Math.pow(state.transform.escalaMetrosPorPixel, 2);
    });
    var geojson = window.IntegralOrtofoto.poligonosParaGeoJSON(state.poligonos, state.transform, {
      arquivo_origem: state.nomeArquivo || null,
      escala_aproximada_m_por_pixel: state.transform.escalaMetrosPorPixel
    });
    downloadBlob(JSON.stringify(geojson, null, 2), nomeBase() + ".geojson", "application/geo+json");
  }

  function exportarSVG() {
    if (!state.poligonos.length) return alert("Nenhum polígono para exportar.");
    var svgStr = window.IntegralOrtofoto.poligonosParaSVG(state.imagemDataUrl, state.larguraNatural, state.alturaNatural, state.poligonos, CORES);
    downloadBlob(svgStr, nomeBase() + ".svg", "image/svg+xml");
  }

  function exportarPNG() {
    if (!state.imagemDataUrl) return alert("Imagem indisponível para exportação em PNG.");
    if (!state.poligonos.length) return alert("Nenhum polígono para exportar.");
    var canvas = document.createElement("canvas");
    canvas.width = state.larguraNatural;
    canvas.height = state.alturaNatural;
    var ctx = canvas.getContext("2d");
    var imgEl = new Image();
    imgEl.onload = function () {
      ctx.drawImage(imgEl, 0, 0, state.larguraNatural, state.alturaNatural);
      state.poligonos.forEach(function (p, i) {
        if (p.vertices.length < 3) return;
        var cor = CORES[i % CORES.length];
        ctx.beginPath();
        p.vertices.forEach(function (v, vi) { if (vi === 0) ctx.moveTo(v.x, v.y); else ctx.lineTo(v.x, v.y); });
        ctx.closePath();
        ctx.fillStyle = cor + "2e";
        ctx.fill();
        ctx.lineWidth = Math.max(2, state.larguraNatural * 0.0025);
        ctx.strokeStyle = cor;
        ctx.stroke();
        ctx.fillStyle = cor;
        ctx.font = "bold " + Math.max(16, state.larguraNatural * 0.016) + "px sans-serif";
        ctx.fillText(p.rotulo || "", p.vertices[0].x, Math.max(20, p.vertices[0].y - 8));
      });
      canvas.toBlob(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = nomeBase() + ".png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      }, "image/png");
    };
    imgEl.src = state.imagemDataUrl;
  }

  function initExportacao() {
    document.getElementById("btn-export-geojson").addEventListener("click", exportarGeoJSON);
    document.getElementById("btn-export-svg").addEventListener("click", exportarSVG);
    document.getElementById("btn-export-png").addEventListener("click", exportarPNG);
  }

  document.addEventListener("DOMContentLoaded", function () {
    initNavegador();
    initSelecao();
    initDesenho();
    initDetectar();
    initExportacao();
    renderTudo();
  });
})();
