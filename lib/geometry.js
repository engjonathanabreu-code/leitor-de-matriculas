/**
 * lib/geometry.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA
 *
 * Camada DETERMINISTICA de geoprocessamento. Nada neste arquivo usa IA.
 * Responsavel por:
 *   - resolver cada vertice para [lng, lat] WGS84 (via lib/coordinates.js);
 *   - construir a poligonal respeitando a ORDEM DOCUMENTAL (nunca reordenar);
 *   - calcular area e perimetro (Turf.js);
 *   - validar a geometria (auto-intersecao, vertices ausentes/duplicados,
 *     vertice espacialmente incompativel, divergencia de area/perimetro).
 *
 * Modulo UMD: funciona como <script> no navegador (`window.IntegralGeometry`)
 * ou via require() em Node. Depende de Turf.js (global `turf`) e do modulo
 * IntegralCoordinates (lib/coordinates.js).
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      typeof turf !== "undefined" ? turf : require("@turf/turf"),
      require("./coordinates.js")
    );
  } else {
    root.IntegralGeometry = factory(root.turf, root.IntegralCoordinates);
  }
})(typeof self !== "undefined" ? self : this, function (turfLib, Coords) {
  "use strict";

  /**
   * Resolve um vertice (estrutura extraida/editada) para coordenada
   * [lng, lat] em WGS84, de acordo com o sistema de coordenadas do
   * documento. Retorna null se nao houver dados suficientes para
   * posicionar com seguranca (NUNCA presume zona/datum).
   *
   * @param {object} vertex - { latitude, longitude, easting, northing }
   * @param {object} sistema - { tipo: 'UTM'|'GEOGRAFICA', datum, zona, hemisferio }
   */
  function resolveVertexLngLat(vertex, sistema) {
    if (!vertex || !sistema) return null;

    if (vertex.longitude != null && vertex.latitude != null) {
      // ja fornecido em lat/long: converte para WGS84 se o datum for conhecido
      var geo = Coords.geographicToWgs84(vertex.latitude, vertex.longitude, sistema.datum);
      return geo; // pode ser null se conversao falhar
    }

    if (vertex.easting != null && vertex.northing != null) {
      if (!sistema.zona || !sistema.hemisferio || !sistema.datum) return null;
      return Coords.utmToLngLat(
        vertex.easting,
        vertex.northing,
        sistema.zona,
        sistema.hemisferio,
        sistema.datum
      );
    }

    return null;
  }

  /**
   * Constroi a lista de coordenadas [lng, lat] resolvidas, PRESERVANDO A
   * ORDEM DOCUMENTAL dos vertices (nunca reordenar por latitude/longitude/
   * proximidade). Retorna { coords: [...], resolvedIndexes: [...], missing: [...] }
   */
  function resolveAllVertices(vertices, sistema) {
    var coords = [];
    var resolvedIndexes = [];
    var missingIndexes = [];
    vertices.forEach(function (v, i) {
      var ll = resolveVertexLngLat(v, sistema);
      if (ll) {
        coords.push(ll);
        resolvedIndexes.push(i);
      } else {
        missingIndexes.push(i);
      }
    });
    return { coords: coords, resolvedIndexes: resolvedIndexes, missingIndexes: missingIndexes };
  }

  /**
   * Constroi o poligono (GeoJSON Feature<Polygon>) a partir de uma lista
   * ordenada de coordenadas [lng, lat], fechando automaticamente o anel.
   */
  function buildPolygon(coordsLngLat) {
    if (!coordsLngLat || coordsLngLat.length < 3) return null;
    var ring = coordsLngLat.slice();
    var first = ring[0];
    var last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
    try {
      return turfLib.polygon([ring]);
    } catch (e) {
      return null;
    }
  }

  /** Area em m² (Turf.js calcula em m² por padrao). */
  function calculateAreaM2(polygonFeature) {
    if (!polygonFeature) return null;
    try {
      return turfLib.area(polygonFeature);
    } catch (e) {
      return null;
    }
  }

  /** Perimetro em metros, somando os segmentos consecutivos do anel externo. */
  function calculatePerimeterM(coordsLngLat) {
    if (!coordsLngLat || coordsLngLat.length < 2) return null;
    var total = 0;
    var ring = coordsLngLat.slice();
    var first = ring[0];
    var last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    for (var i = 0; i < ring.length - 1; i++) {
      total += Coords.distanceMeters(ring[i], ring[i + 1]);
    }
    return total;
  }

  /** Distancia (m) entre dois vertices consecutivos, util p/ tabela. */
  function segmentDistances(coordsLngLat) {
    var out = [];
    for (var i = 0; i < coordsLngLat.length; i++) {
      var a = coordsLngLat[i];
      var b = coordsLngLat[(i + 1) % coordsLngLat.length];
      out.push(Coords.distanceMeters(a, b));
    }
    return out;
  }

  /** Compara valor registral x calculado. Retorna null se registral ausente. */
  function compareValues(registral, calculado) {
    if (registral == null || calculado == null || isNaN(registral)) return null;
    var diff = calculado - registral;
    var pct = registral !== 0 ? (diff / registral) * 100 : null;
    return { diferenca: diff, percentual: pct };
  }

  /** Verifica auto-intersecao do poligono usando turf.kinks. */
  function hasSelfIntersection(polygonFeature) {
    if (!polygonFeature) return false;
    try {
      var kinks = turfLib.kinks(polygonFeature);
      return kinks && kinks.features && kinks.features.length > 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Detecta vertices espacialmente incompativeis com o restante do conjunto
   * (ex.: 1 vertice caiu no oceano ou em outro estado). Usa a distancia de
   * cada ponto ao centroide e compara com a mediana das distancias.
   * threshold padrao: um ponto e' outlier se sua distancia ao centroide for
   * maior que 8x a distancia mediana E maior que 5 km em termos absolutos.
   */
  function detectSpatialOutliers(coordsLngLat, opts) {
    opts = opts || {};
    var factor = opts.factor || 8;
    var absoluteKm = opts.absoluteKm != null ? opts.absoluteKm : 5;
    if (!coordsLngLat || coordsLngLat.length < 3) return [];

    var centroid = turfLib.centroid(turfLib.multiPoint(coordsLngLat));
    var centroidCoord = centroid.geometry.coordinates;

    var dists = coordsLngLat.map(function (c) {
      return Coords.distanceMeters(centroidCoord, c);
    });

    var sorted = dists.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    var median =
      sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    var outliers = [];
    dists.forEach(function (d, i) {
      var isFar = median > 0 ? d > median * factor : d > absoluteKm * 1000;
      var isAbsoluteFar = d > absoluteKm * 1000;
      if (isFar && isAbsoluteFar) outliers.push(i);
    });
    return outliers;
  }

  /**
   * Executa o conjunto de validacoes geometricas descrito na especificacao
   * (secoes 15 e 16) e retorna uma lista de alertas estruturados:
   * { nivel: 'ok' | 'atencao' | 'erro', codigo, mensagem, verticeIndex? }
   */
  function runValidations(ctx) {
    // ctx: { vertices, sistema, coordsLngLat, polygonFeature, areaRegistral,
    //        areaCalculada, perimetroRegistral, perimetroCalculada, missingIndexes }
    var alerts = [];
    var vertices = ctx.vertices || [];

    if (vertices.length < 3) {
      alerts.push({
        nivel: "erro",
        codigo: "VERTICES_INSUFICIENTES",
        mensagem: "Menos de 3 vertices identificados. Nao e possivel construir uma poligonal."
      });
    }

    if (ctx.missingIndexes && ctx.missingIndexes.length > 0) {
      alerts.push({
        nivel: "erro",
        codigo: "COORDENADAS_AUSENTES",
        mensagem:
          "Nao foi possivel posicionar " +
          ctx.missingIndexes.length +
          " vertice(s) por falta de coordenada, zona UTM ou datum. Vertices: " +
          ctx.missingIndexes.map(function (i) { return (vertices[i] && vertices[i].id) || "#" + i; }).join(", ")
      });
    }

    // coordenadas duplicadas
    if (ctx.coordsLngLat && ctx.coordsLngLat.length > 1) {
      var seen = {};
      ctx.coordsLngLat.forEach(function (c, i) {
        var key = c[0].toFixed(7) + "," + c[1].toFixed(7);
        if (seen[key] !== undefined) {
          alerts.push({
            nivel: "atencao",
            codigo: "COORDENADA_DUPLICADA",
            mensagem: "Coordenadas repetidas entre vertices (indices " + seen[key] + " e " + i + ")."
          });
        } else {
          seen[key] = i;
        }
      });
    }

    if (ctx.polygonFeature) {
      if (hasSelfIntersection(ctx.polygonFeature)) {
        alerts.push({
          nivel: "erro",
          codigo: "AUTO_INTERSECAO",
          mensagem: "A poligonal possui auto-intersecao (linhas se cruzando). Verifique a ordem dos vertices."
        });
      }
    } else if (vertices.length >= 3) {
      alerts.push({
        nivel: "erro",
        codigo: "POLIGONO_INVALIDO",
        mensagem: "Nao foi possivel construir um poligono valido com os dados disponiveis."
      });
    }

    if (ctx.coordsLngLat) {
      var outliers = detectSpatialOutliers(ctx.coordsLngLat);
      outliers.forEach(function (idx) {
        var resolvedVertex = vertices[ctx.resolvedIndexes ? ctx.resolvedIndexes[idx] : idx];
        alerts.push({
          nivel: "erro",
          codigo: "VERTICE_ESPACIALMENTE_INCOMPATIVEL",
          mensagem:
            "Possivel erro no vertice " +
            (resolvedVertex ? resolvedVertex.id : "#" + idx) +
            ". A coordenada esta espacialmente incompativel com os demais vertices (possivel erro de OCR/leitura)."
        });
      });
    }

    if (!ctx.sistema || !ctx.sistema.datum) {
      alerts.push({
        nivel: "atencao",
        codigo: "DATUM_AUSENTE",
        mensagem: "Datum/sistema de referencia nao identificado no documento."
      });
    }
    if (ctx.sistema && ctx.sistema.tipo === "UTM" && !ctx.sistema.zona) {
      alerts.push({
        nivel: "atencao",
        codigo: "ZONA_UTM_AUSENTE",
        mensagem: "Zona UTM nao identificada. Nao e possivel posicionar a geometria com seguranca."
      });
    }

    var areaCmp = compareValues(ctx.areaRegistral, ctx.areaCalculada);
    if (areaCmp && Math.abs(areaCmp.percentual) > 5) {
      alerts.push({
        nivel: "atencao",
        codigo: "DIVERGENCIA_AREA",
        mensagem:
          "Divergencia significativa entre area registral e calculada (" +
          areaCmp.percentual.toFixed(2) +
          "%)."
      });
    }

    var perimCmp = compareValues(ctx.perimetroRegistral, ctx.perimetroCalculado);
    if (perimCmp && Math.abs(perimCmp.percentual) > 5) {
      alerts.push({
        nivel: "atencao",
        codigo: "DIVERGENCIA_PERIMETRO",
        mensagem:
          "Divergencia significativa entre perimetro registral e calculado (" +
          perimCmp.percentual.toFixed(2) +
          "%)."
      });
    }

    // segmentos anormais: muito curtos (<0.5m) ou desproporcionalmente longos
    if (ctx.coordsLngLat && ctx.coordsLngLat.length >= 2) {
      var segs = segmentDistances(ctx.coordsLngLat);
      var maxSeg = Math.max.apply(null, segs);
      var avgSeg = segs.reduce(function (a, b) { return a + b; }, 0) / segs.length;
      segs.forEach(function (d, i) {
        if (d < 0.3) {
          alerts.push({
            nivel: "atencao",
            codigo: "SEGMENTO_MUITO_CURTO",
            mensagem: "Segmento " + (i + 1) + " possui distancia muito curta (" + d.toFixed(2) + " m)."
          });
        } else if (avgSeg > 0 && d > avgSeg * 10 && maxSeg > 200) {
          alerts.push({
            nivel: "atencao",
            codigo: "SEGMENTO_ANORMAL",
            mensagem:
              "Segmento " + (i + 1) + " possui distancia muito maior que a media dos demais (" + d.toFixed(2) + " m)."
          });
        }
      });
    }

    if (alerts.length === 0) {
      alerts.push({ nivel: "ok", codigo: "POLIGONAL_VALIDA", mensagem: "Poligonal valida." });
    }

    return alerts;
  }

  return {
    resolveVertexLngLat: resolveVertexLngLat,
    resolveAllVertices: resolveAllVertices,
    buildPolygon: buildPolygon,
    calculateAreaM2: calculateAreaM2,
    calculatePerimeterM: calculatePerimeterM,
    segmentDistances: segmentDistances,
    compareValues: compareValues,
    hasSelfIntersection: hasSelfIntersection,
    detectSpatialOutliers: detectSpatialOutliers,
    runValidations: runValidations
  };
});
