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
   */
  function parseDMSToDecimal(str) {
    if (str == null) return null;
    var s = String(str).trim();
    var re = /(-?\d+(?:[.,]\d+)?)\s*[°ºd]?\s*(\d+(?:[.,]\d+)?)?\s*['´′]?\s*(\d+(?:[.,]\d+)?)?\s*["″]?\s*([NSEWnsew])?/;
    var m = s.match(re);
    if (!m) return null;
    var deg = parseFloat(m[1].replace(",", "."));
    var min = m[2] ? parseFloat(m[2].replace(",", ".")) : 0;
    var sec = m[3] ? parseFloat(m[3].replace(",", ".")) : 0;
    if (isNaN(deg)) return null;
    var sign = deg < 0 ? -1 : 1;
    var decimal = sign * (Math.abs(deg) + min / 60 + sec / 3600);
    var hemi = m[4] ? m[4].toUpperCase() : null;
    if (hemi === "S" || hemi === "W") decimal = -Math.abs(decimal);
    if (hemi === "N" || hemi === "E") decimal = Math.abs(decimal);
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
   * Converte rumo (formato quadrante, ex.: "N 45°30'12\"W") para azimute
   * (0-360 a partir do Norte, sentido horario).
   */
  function rumoToAzimuth(rumoStr) {
    if (!rumoStr) return null;
    var s = String(rumoStr).trim().toUpperCase();
    var m = s.match(/^([NS])\s*([0-9°º'"´′″.,\s]+)\s*([EW])$/);
    if (!m) return null;
    var quad1 = m[1];
    var angleStr = m[2];
    var quad2 = m[3];
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

  // ---------------------------------------------------------------------
  // Geodesia elipsoidal (Vincenty, elipsoide WGS84) - problema direto e
  // inverso. Substitui a antiga aproximacao esferica (raio unico), que
  // introduzia um erro sistematico de posicionamento (~0,1% a 0,5%
  // dependendo da latitude) em cada segmento calculado por azimute/
  // distancia. Numa poligonal com varios vertices "CALCULADO" em cadeia
  // (secao 19), esse erro se acumulava segmento a segmento e se refletia
  // na area/perimetro final. Vincenty e o metodo padrao em agrimensura/
  // geoprocessamento para este problema, com precisao sub-milimetrica
  // para distancias tipicas de imoveis (nao antipodais).
  // ---------------------------------------------------------------------
  var WGS84_A = 6378137.0; // semieixo maior (m)
  var WGS84_F = 1 / 298.257223563; // achatamento
  var WGS84_B = (1 - WGS84_F) * WGS84_A; // semieixo menor (m)

  /**
   * Problema geodesico DIRETO (Vincenty): dado um ponto inicial [lng, lat]
   * em WGS84, um azimute (graus, a partir do Norte, sentido horario) e uma
   * distancia (metros) sobre o elipsoide, calcula o ponto de destino.
   * Retorna [lng, lat].
   *
   * Esta funcao NAO usa IA - e usada exclusivamente pelo modulo de
   * reconstrucao por azimute/distancia (secao 19 da especificacao).
   */
  function destinationPoint(lngLat, azimuthDeg, distanceMeters) {
    var a = WGS84_A, b = WGS84_B, f = WGS84_F;
    var s = Number(distanceMeters);
    var alpha1 = (Number(azimuthDeg) * Math.PI) / 180;
    var lat1 = (lngLat[1] * Math.PI) / 180;
    var lng1 = (lngLat[0] * Math.PI) / 180;

    if (!isFinite(s) || s === 0) return [lngLat[0], lngLat[1]];

    var sinAlpha1 = Math.sin(alpha1);
    var cosAlpha1 = Math.cos(alpha1);

    var tanU1 = (1 - f) * Math.tan(lat1);
    var cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
    var sinU1 = tanU1 * cosU1;

    var sigma1 = Math.atan2(tanU1, cosAlpha1);
    var sinAlpha = cosU1 * sinAlpha1;
    var cosSqAlpha = 1 - sinAlpha * sinAlpha;
    var uSq = cosSqAlpha * (a * a - b * b) / (b * b);
    var A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    var B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

    var sigma = s / (b * A);
    var sigmaP, cosTwoSigmaM, sinSigma, cosSigma, deltaSigma;
    var iterations = 0;
    do {
      cosTwoSigmaM = Math.cos(2 * sigma1 + sigma);
      sinSigma = Math.sin(sigma);
      cosSigma = Math.cos(sigma);
      deltaSigma =
        B *
        sinSigma *
        (cosTwoSigmaM +
          (B / 4) *
            (cosSigma * (-1 + 2 * cosTwoSigmaM * cosTwoSigmaM) -
              (B / 6) * cosTwoSigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cosTwoSigmaM * cosTwoSigmaM)));
      sigmaP = sigma;
      sigma = s / (b * A) + deltaSigma;
    } while (Math.abs(sigma - sigmaP) > 1e-12 && ++iterations < 200);

    var x = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
    var tmp = sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1;
    var lat2 = Math.atan2(tmp, (1 - f) * Math.sqrt(sinAlpha * sinAlpha + x * x));
    var lambda = Math.atan2(sinSigma * sinAlpha1, cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1);
    var C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    var L =
      lambda -
      (1 - C) *
        f *
        sinAlpha *
        (sigma + C * sinSigma * (cosTwoSigmaM + C * cosSigma * (-1 + 2 * cosTwoSigmaM * cosTwoSigmaM)));
    var lng2 = lng1 + L;

    return [(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
  }

  /**
   * Problema geodesico INVERSO (Vincenty): distancia (metros) sobre o
   * elipsoide WGS84 entre dois pontos [lng, lat]. Se os pontos coincidirem
   * ou o metodo nao convergir (caso raro, essencialmente antipodal - nao
   * ocorre em vertices de um mesmo imovel), cai de volta para a formula
   * de haversine (esferica) apenas como salvaguarda, sem afetar o caso de
   * uso real desta aplicacao.
   */
  function distanceMeters(a, b) {
    var pA = WGS84_A, pB = WGS84_B, f = WGS84_F;
    var lat1 = (a[1] * Math.PI) / 180;
    var lat2 = (b[1] * Math.PI) / 180;
    var L = ((b[0] - a[0]) * Math.PI) / 180;

    if (a[0] === b[0] && a[1] === b[1]) return 0;

    var tanU1 = (1 - f) * Math.tan(lat1);
    var cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
    var sinU1 = tanU1 * cosU1;
    var tanU2 = (1 - f) * Math.tan(lat2);
    var cosU2 = 1 / Math.sqrt(1 + tanU2 * tanU2);
    var sinU2 = tanU2 * cosU2;

    var lambda = L;
    var lambdaP, sinSigma, cosSigma, sigma, sinAlpha, cosSqAlpha, cosTwoSigmaM;
    var iterations = 0;
    var converged = false;

    do {
      var sinLambda = Math.sin(lambda);
      var cosLambda = Math.cos(lambda);
      sinSigma = Math.sqrt(
        Math.pow(cosU2 * sinLambda, 2) + Math.pow(cosU1 * sinU2 - sinU1 * cosU2 * cosLambda, 2)
      );
      if (sinSigma === 0) return 0; // pontos coincidentes
      cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
      sigma = Math.atan2(sinSigma, cosSigma);
      sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
      cosSqAlpha = 1 - sinAlpha * sinAlpha;
      cosTwoSigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;
      var C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
      lambdaP = lambda;
      lambda =
        L +
        (1 - C) *
          f *
          sinAlpha *
          (sigma + C * sinSigma * (cosTwoSigmaM + C * cosSigma * (-1 + 2 * cosTwoSigmaM * cosTwoSigmaM)));
      iterations++;
    } while (Math.abs(lambda - lambdaP) > 1e-12 && iterations < 200);

    if (iterations < 200) converged = true;

    if (!converged) {
      // salvaguarda: haversine esferico (nao deve ocorrer para vertices
      // de um mesmo imovel, distancias tipicas de dezenas/centenas de m).
      var R = 6378137;
      var dLat = lat2 - lat1;
      var dLng = L;
      var h =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      var c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
      return R * c;
    }

    var uSq = (cosSqAlpha * (pA * pA - pB * pB)) / (pB * pB);
    var A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    var B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    var deltaSigma =
      B *
      sinSigma *
      (cosTwoSigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cosTwoSigmaM * cosTwoSigmaM) -
            (B / 6) * cosTwoSigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cosTwoSigmaM * cosTwoSigmaM)));

    return pB * A * (sigma - deltaSigma);
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
