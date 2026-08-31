/**
 * lib/coordinates.js
 * ---------------------------------------------------------------------------
 * INTEGRAL GEO MATRICULA
 *
 * Camada DETERMINISTICA de coordenadas. Nada neste arquivo usa IA.
 * Responsavel por:
 *   - reconhecer/parsear formatos de coordenadas (decimal, GMS, UTM);
 *   - converter UTM -> longitude/latitude (WGS84) para exibicao no mapa;
 *   - reconstruir vertices a partir de azimute/distancia (geodesia esferica);
 *   - converter rumo (quadrante) <-> azimute.
 *
 * Modulo UMD: funciona tanto como <script> no navegador (expondo
 * `window.IntegralCoordinates`) quanto via require() em Node.js.
 *
 * Depende da biblioteca proj4 (proj4js), que deve estar carregada
 * globalmente (CDN no navegador, ou `require('proj4')` em Node).
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(typeof proj4 !== "undefined" ? proj4 : require("proj4"));
  } else {
    root.IntegralCoordinates = factory(root.proj4);
  }
})(typeof self !== "undefined" ? self : this, function (proj4lib) {
  "use strict";

  // ---------------------------------------------------------------------
  // Definicoes de datum (elipsoide + parametros de transformacao Molodensky
  // de 7/3 parametros aproximados para WGS84). Valores de referencia de uso
  // corrente em cartografia brasileira. Sao aproximacoes de engenharia,
  // suficientes para posicionamento e visualizacao em mapa - NAO substituem
  // uma transformacao geodesica oficial (ex.: PROGRID/IBGE) para fins de
  // georreferenciamento certificado junto ao INCRA.
  // ---------------------------------------------------------------------
  var DATUM_DEFS = {
    WGS84: "+proj=longlat +datum=WGS84 +no_defs",
    SIRGAS2000: "+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs",
    SAD69: "+proj=longlat +ellps=aust_SA +towgs84=-67.35,3.88,-38.22,0,0,0,0 +no_defs",
    "CORREGO ALEGRE": "+proj=longlat +ellps=intl +towgs84=-205.57,168.77,-4.12,0,0,0,0 +no_defs",
    "CORREGO ALEGRE 1970-72": "+proj=longlat +ellps=intl +towgs84=-205.57,168.77,-4.12,0,0,0,0 +no_defs",
    ASTRO_CHUA: "+proj=longlat +ellps=intl +towgs84=-134.17,110.75,-23.83,0,0,0,0 +no_defs"
  };

  function normalizeDatumName(datum) {
    if (!datum) return null;
    var d = String(datum).toUpperCase().trim();
    d = d.replace(/\s+/g, " ");
    if (d.indexOf("SIRGAS") !== -1) return "SIRGAS2000";
    if (d.indexOf("SAD") !== -1 && d.indexOf("69") !== -1) return "SAD69";
    if (d.indexOf("CORREGO") !== -1 || d.indexOf("CÓRREGO") !== -1) return "CORREGO ALEGRE";
    if (d.indexOf("CHUA") !== -1 || d.indexOf("CHUÁ") !== -1) return "ASTRO_CHUA";
    if (d.indexOf("WGS") !== -1) return "WGS84";
    return null; // desconhecido: nao presumir
  }

  function getGeographicProjDef(datum) {
    var key = normalizeDatumName(datum);
    if (!key) return null;
    return DATUM_DEFS[key];
  }

  function getUTMProjDef(zone, hemisphere, datum) {
    var key = normalizeDatumName(datum);
    if (!key || !zone || !hemisphere) return null;
    var base = DATUM_DEFS[key];
    // extrai ellps/towgs84 da definicao geografica e monta a definicao UTM
    var ellpsMatch = base.match(/\+ellps=(\S+)/);
    var datumMatch = base.match(/\+datum=(\S+)/);
    var towgsMatch = base.match(/\+towgs84=(\S+)/);
    var parts = ["+proj=utm", "+zone=" + parseInt(zone, 10)];
    if (String(hemisphere).toUpperCase().startsWith("S")) parts.push("+south");
    if (datumMatch) parts.push("+datum=" + datumMatch[1]);
    if (ellpsMatch) parts.push("+ellps=" + ellpsMatch[1]);
    if (towgsMatch) parts.push("+towgs84=" + towgsMatch[1]);
    parts.push("+units=m +no_defs");
    return parts.join(" ");
  }

  /**
   * Converte um par UTM (easting, northing) para [longitude, latitude] WGS84.
   * Retorna null se datum/zona/hemisferio nao permitirem definir a projecao
   * com seguranca (regra fundamental: nunca presumir).
   */
  function utmToLngLat(easting, northing, zone, hemisphere, datum) {
    if (!proj4lib) throw new Error("proj4 nao esta carregado.");
    if (easting == null || northing == null || !zone || !hemisphere || !datum) return null;
    var utmDef = getUTMProjDef(zone, hemisphere, datum);
    if (!utmDef) return null;
    try {
      var result = proj4lib(utmDef, "WGS84", [Number(easting), Number(northing)]);
      if (!isFinite(result[0]) || !isFinite(result[1])) return null;
      return [result[0], result[1]]; // [lng, lat]
    } catch (e) {
      return null;
    }
  }

  /** Converte longitude/latitude (num datum informado) para WGS84 decimal. */
  function geographicToWgs84(lat, lng, datum) {
    if (!proj4lib) throw new Error("proj4 nao esta carregado.");
    if (lat == null || lng == null) return null;
    var srcDef = getGeographicProjDef(datum);
    if (!srcDef) {
      // sem datum conhecido: assume-se que o valor ja esta em WGS84
      // (comportamento explicito, nao silencioso - o chamador deve
      // gerar alerta correspondente).
      return [Number(lng), Number(lat)];
    }
    try {
      var result = proj4lib(srcDef, "WGS84", [Number(lng), Number(lat)]);
      return [result[0], result[1]];
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Parsing de texto de coordenadas
  // ---------------------------------------------------------------------

  /**
   * Converte string GMS (graus, minutos, segundos) para grau decimal.
   * Aceita formatos como:  26°20'14.221"S   -49°51'07.456"   26 20 14.221 S
   * Hemisferio aceita tanto letras em ingles (N/S/E/W) quanto em portugues
   * (N/S/L/O - Norte/Sul/Leste/Oeste), como e comum em documentos
   * brasileiros de registro de imoveis (ex.: "49°34'08,4291\" O").
   */
  function parseDMSToDecimal(str) {
    if (str == null) return null;
    var s = String(str).trim();
    var re = /(-?\d+(?:[.,]\d+)?)\s*[°ºd]?\s*(\d+(?:[.,]\d+)?)?\s*['´′]?\s*(\d+(?:[.,]\d+)?)?\s*["″]?\s*([NSELOnselo])?/;
    var m = s.match(re);
    if (!m) return null;
    var deg = parseFloat(m[1].replace(",", "."));
    var min = m[2] ? parseFloat(m[2].replace(",", ".")) : 0;
    var sec = m[3] ? parseFloat(m[3].replace(",", ".")) : 0;
    if (isNaN(deg)) return null;
    var sign = deg < 0 ? -1 : 1;
    var decimal = sign * (Math.abs(deg) + min / 60 + sec / 3600);
    var hemi = m[4] ? m[4].toUpperCase() : null;
    if (hemi === "S" || hemi === "W" || hemi === "O") decimal = -Math.abs(decimal);
    if (hemi === "N" || hemi === "E" || hemi === "L") decimal = Math.abs(decimal);
    return decimal;
  }

  /** Tenta interpretar uma string numerica decimal simples (com virgula ou ponto). */
  function parseDecimal(str) {
    if (str == null) return null;
    if (typeof str === "number") return isFinite(str) ? str : null;
    var s = String(str).trim().replace(/\./g, "").replace(",", ".");
    // fallback: se so havia um separador decimal (ponto), a linha acima
    // pode ter removido incorretamente; tenta tambem a forma direta.
    var direct = parseFloat(String(str).trim().replace(",", "."));
    var val = parseFloat(s);
    if (!isNaN(direct) && Math.abs(direct) < 1000) return direct; // graus decimais tipicos
    if (!isNaN(val)) return val;
    if (!isNaN(direct)) return direct;
    return null;
  }

  /**
   * Converte azimute (0-360, a partir do Norte, sentido horario) para o
   * "bearing" usado pelo Turf.js (-180 a 180, 0 = Norte).
   */
  function azimuthToTurfBearing(azimuthDeg) {
    var az = ((Number(azimuthDeg) % 360) + 360) % 360;
    return az > 180 ? az - 360 : az;
  }

  function turfBearingToAzimuth(bearingDeg) {
    var b = Number(bearingDeg);
    return b < 0 ? b + 360 : b;
  }

  /**
   * Converte rumo (formato quadrante, ex.: "N 45°30'12\"W" ou "N 45°30'12\"O")
   * para azimute (0-360 a partir do Norte, sentido horario). Aceita
   * quadrantes em ingles (N/S/E/W) ou portugues (N/S/L/O).
   */
  function rumoToAzimuth(rumoStr) {
    if (!rumoStr) return null;
    var s = String(rumoStr).trim().toUpperCase();
    var m = s.match(/^([NS])\s*([0-9°'"´′″.,\s]+)\s*([ELOW])$/);
    if (!m) return null;
    var quad1 = m[1];
    var angleStr = m[2];
    var quad2raw = m[3];
    var quad2 = quad2raw === "L" ? "E" : quad2raw === "O" ? "W" : quad2raw;
    var angle = parseDMSToDecimal(angleStr.replace(/\s+$/, ""));
    if (angle == null) {
      angle = parseDecimal(angleStr);
    }
    if (angle == null) return null;
    angle = Math.abs(angle);
    var azimuth;
    if (quad1 === "N" && quad2 === "E") azimuth = angle;
    else if (quad1 === "S" && quad2 === "E") azimuth = 180 - angle;
    else if (quad1 === "S" && quad2 === "W") azimuth = 180 + angle;
    else if (quad1 === "N" && quad2 === "W") azimuth = 360 - angle;
    else return null;
    return azimuth;
  }

  /**
   * Dado um ponto inicial [lng, lat] em WGS84, um azimute (graus, a partir
   * do Norte) e uma distancia (metros), calcula o ponto de destino usando
   * geodesia esferica (formula direta de Vincenty simplificada / grande
   * circulo). Retorna [lng, lat].
   *
   * Esta funcao NAO usa IA - e usada exclusivamente pelo modulo de
   * reconstrucao por azimute/distancia (secao 19 da especificacao).
   */
  function destinationPoint(lngLat, azimuthDeg, distanceMeters) {
    var R = 6378137; // raio equatorial WGS84, aproximacao esferica (m)
    var lng1 = (lngLat[0] * Math.PI) / 180;
    var lat1 = (lngLat[1] * Math.PI) / 180;
    var brng = (Number(azimuthDeg) * Math.PI) / 180;
    var d = Number(distanceMeters) / R;

    var lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
    );
    var lng2 =
      lng1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
      );

    return [(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
  }

  /** Distancia geodesica aproximada (metros) entre dois pontos [lng,lat]. */
  function distanceMeters(a, b) {
    var R = 6378137;
    var lat1 = (a[1] * Math.PI) / 180;
    var lat2 = (b[1] * Math.PI) / 180;
    var dLat = ((b[1] - a[1]) * Math.PI) / 180;
    var dLng = ((b[0] - a[0]) * Math.PI) / 180;
    var h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    var c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return R * c;
  }

  return {
    DATUM_DEFS: DATUM_DEFS,
    normalizeDatumName: normalizeDatumName,
    getGeographicProjDef: getGeographicProjDef,
    getUTMProjDef: getUTMProjDef,
    utmToLngLat: utmToLngLat,
    geographicToWgs84: geographicToWgs84,
    parseDMSToDecimal: parseDMSToDecimal,
    parseDecimal: parseDecimal,
    azimuthToTurfBearing: azimuthToTurfBearing,
    turfBearingToAzimuth: turfBearingToAzimuth,
    rumoToAzimuth: rumoToAzimuth,
    destinationPoint: destinationPoint,
    distanceMeters: distanceMeters
  };
});
