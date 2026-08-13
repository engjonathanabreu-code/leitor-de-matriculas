/**
 * lib/export.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA
 *
 * Geracao deterministica dos arquivos de exportacao (GeoJSON, KML, CSV, TXT)
 * a partir do resultado ja validado/calculado. Nao usa IA.
 *
 * Modulo UMD: `window.IntegralExport` no navegador ou require() em Node.
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.IntegralExport = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function xmlEscape(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function csvEscape(val) {
    if (val == null) return "";
    var s = String(val);
    if (s.indexOf(";") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * @param {object} data
   *   {
   *     matricula: { numero, cartorio, comarca, municipio, estado },
   *     proprietario: { nome },
   *     areaRegistral, areaCalculada, perimetroCalculado,
   *     vertices: [ { id, easting, northing, latitude, longitude,
   *                   distancia_para_proximo, azimute_para_proximo,
   *                   confrontante_para_proximo } ],
   *     coordsLngLat: [ [lng,lat], ... ]  (ordem documental, resolvidos)
   *   }
   */
  function toGeoJSON(data) {
    var ring = (data.coordsLngLat || []).map(function (c) {
      return [c[0], c[1]];
    });
    if (ring.length > 0) {
      var first = ring[0];
      var last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    }

    var feature = {
      type: "Feature",
      properties: {
        matricula: (data.matricula && data.matricula.numero) || null,
        cartorio: (data.matricula && data.matricula.cartorio) || null,
        municipio: (data.matricula && data.matricula.municipio) || null,
        estado: (data.matricula && data.matricula.estado) || null,
        proprietario: (data.proprietario && data.proprietario.nome) || null,
        area_registral_m2: data.areaRegistral != null ? data.areaRegistral : null,
        area_calculada_m2: data.areaCalculada != null ? data.areaCalculada : null,
        perimetro_calculado_m: data.perimetroCalculado != null ? data.perimetroCalculado : null,
        gerado_por: "INTEGRAL GEO MATRICULA"
      },
      geometry:
        ring.length >= 4
          ? { type: "Polygon", coordinates: [ring] }
          : { type: "MultiPoint", coordinates: ring }
    };

    return {
      type: "FeatureCollection",
      features: [feature]
    };
  }

  function toKML(data) {
    var nome = "Matricula " + ((data.matricula && data.matricula.numero) || "s/n");
    var ring = data.coordsLngLat || [];
    var closed = ring.slice();
    if (closed.length > 0) {
      var first = closed[0];
      var last = closed[closed.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) closed.push(first);
    }
    var coordStr = closed.map(function (c) { return c[0] + "," + c[1] + ",0"; }).join(" ");

    var placemarks = [];
    placemarks.push(
      "  <Placemark>\n" +
        "    <name>" + xmlEscape(nome) + "</name>\n" +
        "    <description>" +
        xmlEscape(
          "Proprietario: " + ((data.proprietario && data.proprietario.nome) || "N/D") +
          " | Area calculada: " + (data.areaCalculada != null ? data.areaCalculada.toFixed(2) + " m2" : "N/D")
        ) +
        "</description>\n" +
        "    <Style><LineStyle><color>ff0033b3</color><width>3</width></LineStyle>" +
        "<PolyStyle><color>4d0033b3</color></PolyStyle></Style>\n" +
        "    <Polygon>\n" +
        "      <outerBoundaryIs><LinearRing><coordinates>" +
        coordStr +
        "</coordinates></LinearRing></outerBoundaryIs>\n" +
        "    </Polygon>\n" +
        "  </Placemark>"
    );

    (data.vertices || []).forEach(function (v, i) {
      var c = (data.coordsLngLat || [])[i];
      if (!c) return;
      placemarks.push(
        "  <Placemark>\n" +
          "    <name>" + xmlEscape(v.id) + "</name>\n" +
          "    <Point><coordinates>" + c[0] + "," + c[1] + ",0</coordinates></Point>\n" +
          "  </Placemark>"
      );
    });

    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
      "<Document>\n" +
      "  <name>" + xmlEscape(nome) + "</name>\n" +
      placemarks.join("\n") +
      "\n</Document>\n</kml>\n"
    );
  }

  function toCSV(data) {
    var header = ["Vertice", "Easting", "Northing", "Latitude", "Longitude", "Azimute", "Distancia", "Confrontante"];
    var lines = [header.join(";")];
    (data.vertices || []).forEach(function (v) {
      lines.push(
        [
          csvEscape(v.id),
          csvEscape(v.easting),
          csvEscape(v.northing),
          csvEscape(v.latitude),
          csvEscape(v.longitude),
          csvEscape(v.azimute_para_proximo),
          csvEscape(v.distancia_para_proximo),
          csvEscape(v.confrontante_para_proximo)
        ].join(";")
      );
    });
    return lines.join("\n");
  }

  function toTXT(data) {
    var m = data.matricula || {};
    var p = data.proprietario || {};
    var sc = data.sistemaCoordenadas || {};
    var lines = [];
    lines.push("=".repeat(70));
    lines.push("INTEGRAL GEO MATRICULA - RELATORIO TECNICO");
    lines.push("=".repeat(70));
    lines.push("");
    lines.push("MATRICULA");
    lines.push("Numero: " + (m.numero || "N/D"));
    lines.push("Cartorio: " + (m.cartorio || "N/D"));
    lines.push("Comarca: " + (m.comarca || "N/D"));
    lines.push("Municipio: " + (m.municipio || "N/D"));
    lines.push("UF: " + (m.estado || "N/D"));
    lines.push("");
    lines.push("PROPRIETARIO");
    lines.push("Nome: " + (p.nome || "N/D"));
    lines.push("");
    lines.push("GEORREFERENCIAMENTO");
    lines.push("Sistema: " + (sc.tipo || "N/D"));
    lines.push("Datum: " + (sc.datum || "N/D"));
    lines.push("EPSG: " + (sc.epsg || "N/D"));
    lines.push("Zona: " + (sc.zona || "N/D"));
    lines.push("Hemisferio: " + (sc.hemisferio || "N/D"));
    lines.push("");
    lines.push("AREA E PERIMETRO");
    lines.push("Area registral: " + (data.areaRegistral != null ? data.areaRegistral.toFixed(2) + " m2" : "N/D"));
    lines.push("Area calculada: " + (data.areaCalculada != null ? data.areaCalculada.toFixed(2) + " m2" : "N/D"));
    lines.push("Perimetro calculado: " + (data.perimetroCalculado != null ? data.perimetroCalculado.toFixed(2) + " m" : "N/D"));
    lines.push("");
    lines.push("VERTICES (ordem documental)");
    lines.push("-".repeat(70));
    (data.vertices || []).forEach(function (v) {
      lines.push(
        v.id +
          " | E: " + (v.easting != null ? v.easting : v.longitude != null ? v.longitude : "N/D") +
          " | N: " + (v.northing != null ? v.northing : v.latitude != null ? v.latitude : "N/D") +
          " | Dist. prox.: " + (v.distancia_para_proximo != null ? v.distancia_para_proximo + " m" : "N/D") +
          " | Azimute: " + (v.azimute_para_proximo || "N/D") +
          " | Confrontante: " + (v.confrontante_para_proximo || "N/D")
      );
    });
    lines.push("");
    lines.push("ALERTAS");
    lines.push("-".repeat(70));
    (data.alertas || []).forEach(function (a) {
      lines.push("[" + a.nivel.toUpperCase() + "] " + a.mensagem);
    });
    lines.push("");
    lines.push("Documento gerado automaticamente por INTEGRAL GEO MATRICULA.");
    lines.push("Requer conferencia tecnica de um profissional habilitado.");
    return lines.join("\n");
  }

  return {
    toGeoJSON: toGeoJSON,
    toKML: toKML,
    toCSV: toCSV,
    toTXT: toTXT
  };
});
