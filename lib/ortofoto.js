/**
 * lib/ortofoto.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA - PROTOTIPO "Ortofoto -> divisao de lotes"
 *
 * Camada DETERMINISTICA (nenhuma IA aqui), no mesmo espirito de
 * lib/geometry.js: a IA (api/analisar-ortofoto.js) so PROPOE poligonos em
 * coordenadas de pixel normalizadas (0..1), com base em evidencia visual
 * (muros, cercas, alinhamentos, mudanca de textura). Toda conta a partir
 * dai - area, georreferenciamento por pontos de controle e exportacao -
 * acontece aqui, no navegador, e pode ser editada manualmente a qualquer
 * momento antes de exportar.
 *
 * GEORREFERENCIAMENTO (protótipo, aproximado):
 * A partir de 2 pontos de controle (pixel <-> lat/long conhecida), calculamos
 * uma transformacao de similaridade 2D (Helmert: rotacao + escala uniforme +
 * translacao, sem espelhamento) que leva qualquer pixel da imagem a uma
 * coordenada geografica aproximada. Isso assume:
 *   - a ortofoto esta orientada para o norte (topo = norte, direita = leste),
 *     como e o padrao em voos fotogrametricos e na maioria das bases publicas;
 *   - a area coberta e pequena o suficiente (escala de lote/quadra) para que
 *     a aproximacao planar "metros por grau" em torno do ponto de origem seja
 *     valida.
 * Isso e SUFICIENTE para um protótipo de apoio visual, mas NAO substitui
 * georreferenciamento fotogrametrico/GNSS para fins de registro oficial -
 * a interface sempre deve exibir esse aviso ao usuario.
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.IntegralOrtofoto = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEG2RAD = Math.PI / 180;
  var METROS_POR_GRAU_LAT = 110540; // aproximacao esferica, suficiente em escala de lote/quadra

  function metrosPorGrauLng(latGraus) {
    return 111320 * Math.cos(latGraus * DEG2RAD);
  }

  /** Area (valor absoluto) de um poligono em pixel², via formula do shoelace. Nao fecha o anel automaticamente na entrada - assume vertices sem repetir o primeiro no final. */
  function areaShoelacePx(verticesPx) {
    if (!verticesPx || verticesPx.length < 3) return 0;
    var soma = 0;
    for (var i = 0; i < verticesPx.length; i++) {
      var a = verticesPx[i];
      var b = verticesPx[(i + 1) % verticesPx.length];
      soma += a.x * b.y - b.x * a.y;
    }
    return Math.abs(soma) / 2;
  }

  /** Perimetro em pixels (soma dos segmentos, incluindo o de fechamento). */
  function perimetroPx(verticesPx) {
    if (!verticesPx || verticesPx.length < 2) return 0;
    var total = 0;
    for (var i = 0; i < verticesPx.length; i++) {
      var a = verticesPx[i];
      var b = verticesPx[(i + 1) % verticesPx.length];
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return total;
  }

  /**
   * Calcula a transformacao pixel -> [lng, lat] a partir de exatamente 2
   * pontos de controle. Retorna null se os pontos forem invalidos/coincidentes.
   * pontos: [{px,py,lng,lat}, {px,py,lng,lat}]
   * Retorna { escalaMetrosPorPixel, pixelParaLngLat(px,py) -> [lng,lat] }.
   */
  function calibrarTransformacao(pontos) {
    if (!pontos || pontos.length !== 2) return null;
    var p1 = pontos[0], p2 = pontos[1];
    var valido = [p1, p2].every(function (p) {
      return p && isFinite(p.px) && isFinite(p.py) && isFinite(p.lng) && isFinite(p.lat);
    });
    if (!valido) return null;

    var lat0 = p1.lat, lng0 = p1.lng;
    var mLat = METROS_POR_GRAU_LAT;
    var mLng = metrosPorGrauLng(lat0);
    if (!isFinite(mLng) || Math.abs(mLng) < 1e-6) return null;

    // p1 e a origem do plano local (0,0). O eixo y local cresce para o SUL
    // (mesmo sentido que y cresce para baixo na imagem), assumindo imagem
    // orientada para o norte - ver nota no topo do arquivo. Isso preserva a
    // "lateralidade" entre os dois planos, para que uma transformacao de
    // similaridade pura (sem espelhamento) seja suficiente.
    var w2x = (p2.lng - lng0) * mLng;
    var w2y = -(p2.lat - lat0) * mLat;

    var dx = p2.px - p1.px;
    var dy = p2.py - p1.py;
    var denom = dx * dx + dy * dy;
    if (denom < 1e-9) return null; // pontos de pixel coincidentes

    // k = w2 / (z2 - z1), em numeros complexos representados como (re, im).
    var kRe = (w2x * dx + w2y * dy) / denom;
    var kIm = (w2y * dx - w2x * dy) / denom;
    var escalaMetrosPorPixel = Math.hypot(kRe, kIm);

    function pixelParaLngLat(px, py) {
      var ddx = px - p1.px;
      var ddy = py - p1.py;
      var wx = kRe * ddx - kIm * ddy;
      var wy = kIm * ddx + kRe * ddy;
      var lat = lat0 - wy / mLat;
      var lng = lng0 + wx / mLng;
      return [lng, lat];
    }

    return { escalaMetrosPorPixel: escalaMetrosPorPixel, pixelParaLngLat: pixelParaLngLat };
  }

  /** Converte um poligono (vertices em pixel) para Feature GeoJSON WGS84, usando a transformacao calibrada. Retorna null sem calibracao. */
  function poligonoParaGeoJSONFeature(poligono, transform) {
    if (!transform || !poligono || !poligono.vertices || poligono.vertices.length < 3) return null;
    var anel = poligono.vertices.map(function (v) { return transform.pixelParaLngLat(v.x, v.y); });
    anel.push(anel[0]);
    return {
      type: "Feature",
      properties: {
        rotulo: poligono.rotulo || null,
        origem: "proposta_ia_ortofoto_prototipo",
        evidencias: poligono.evidencias || [],
        confianca: poligono.confianca != null ? poligono.confianca : null,
        editado_manualmente: !!poligono.editadoManualmente,
        area_calculada_m2: poligono._areaM2 != null ? poligono._areaM2 : null
      },
      geometry: { type: "Polygon", coordinates: [anel] }
    };
  }

  function poligonosParaGeoJSON(poligonos, transform, meta) {
    var props = {
      gerado_por: "INTEGRAL GEO MATRICULA - protótipo Ortofoto",
      aviso:
        "Poligonos propostos por IA a partir de evidencia visual (muros/cercas/divisas). " +
        "Georreferenciamento aproximado por transformacao de 2 pontos de controle. " +
        "Requer conferencia por profissional habilitado antes de qualquer uso oficial."
    };
    for (var k in meta || {}) props[k] = meta[k];
    return {
      type: "FeatureCollection",
      properties: props,
      features: (poligonos || [])
        .map(function (p) { return poligonoParaGeoJSONFeature(p, transform); })
        .filter(Boolean)
    };
  }

  function escapeXml(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Gera um SVG (string) com a imagem de fundo embutida e os poligonos sobrepostos - editavel em Illustrator/Inkscape/CAD. */
  function poligonosParaSVG(imagemDataUrl, larguraPx, alturaPx, poligonos, cores) {
    var partes = [];
    partes.push(
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + larguraPx + '" height="' + alturaPx +
      '" viewBox="0 0 ' + larguraPx + " " + alturaPx + '">'
    );
    if (imagemDataUrl) {
      partes.push('<image href="' + imagemDataUrl + '" x="0" y="0" width="' + larguraPx + '" height="' + alturaPx + '" />');
    }
    (poligonos || []).forEach(function (p, i) {
      if (!p.vertices || p.vertices.length < 3) return;
      var cor = (cores && cores[i % cores.length]) || "#1d4ed8";
      var pontos = p.vertices.map(function (v) { return v.x.toFixed(1) + "," + v.y.toFixed(1); }).join(" ");
      partes.push('<polygon points="' + pontos + '" fill="' + cor + '" fill-opacity="0.18" stroke="' + cor + '" stroke-width="3" />');
      var primeiro = p.vertices[0];
      partes.push(
        '<text x="' + primeiro.x.toFixed(1) + '" y="' + (primeiro.y - 8).toFixed(1) +
        '" font-family="sans-serif" font-size="20" fill="' + cor + '" font-weight="700">' + escapeXml(p.rotulo || "") + "</text>"
      );
    });
    partes.push("</svg>");
    return partes.join("\n");
  }

  return {
    areaShoelacePx: areaShoelacePx,
    perimetroPx: perimetroPx,
    calibrarTransformacao: calibrarTransformacao,
    poligonoParaGeoJSONFeature: poligonoParaGeoJSONFeature,
    poligonosParaGeoJSON: poligonosParaGeoJSON,
    poligonosParaSVG: poligonosParaSVG
  };
});
