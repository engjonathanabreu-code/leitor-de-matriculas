/**
 * lib/export.js
 * Exportacoes deterministicas do INTEGRAL GEO MATRICULA.
 */
(function(root,factory){
  if(typeof module==="object"&&module.exports){module.exports=factory();}
  else{root.IntegralExport=factory();}
})(typeof self!=="undefined"?self:this,function(){
  "use strict";

  function xmlEscape(v){
    if(v==null)return "";
    return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&apos;");
  }
  function csvEscape(v){
    if(v==null)return "";
    var s=String(v);
    if(/[;\"\n]/.test(s))s='"'+s.replace(/"/g,'""')+'"';
    return s;
  }
  function closedRing(coords){
    var ring=(coords||[]).map(function(c){return [c[0],c[1]];});
    if(ring.length){var a=ring[0],b=ring[ring.length-1];if(a[0]!==b[0]||a[1]!==b[1])ring.push([a[0],a[1]]);}
    return ring;
  }
  function toGeoJSON(data){
    var ring=closedRing(data.coordsLngLat);
    return {type:"FeatureCollection",features:[{type:"Feature",properties:{
      matricula:data.matricula&&data.matricula.numero||null,
      cartorio:data.matricula&&data.matricula.cartorio||null,
      municipio:data.matricula&&data.matricula.municipio||null,
      estado:data.matricula&&data.matricula.estado||null,
      proprietario:data.proprietario&&data.proprietario.nome||null,
      area_registral_m2:data.areaRegistral!=null?data.areaRegistral:null,
      area_calculada_m2:data.areaCalculada!=null?data.areaCalculada:null,
      perimetro_calculado_m:data.perimetroCalculado!=null?data.perimetroCalculado:null,
      gerado_por:"INTEGRAL GEO MATRICULA"
    },geometry:ring.length>=4?{type:"Polygon",coordinates:[ring]}:{type:"MultiPoint",coordinates:ring}}]};
  }
  function toKML(data){
    var numero=data.matricula&&data.matricula.numero||"s/n",nome="Matricula "+numero,ring=closedRing(data.coordsLngLat);
    var coords=ring.map(function(c){return c[0]+","+c[1]+",0";}).join(" "),placemarks=[];
    placemarks.push("  <Placemark>\n    <name>"+xmlEscape(nome)+"</name>\n    <description>"+xmlEscape("Proprietario: "+(data.proprietario&&data.proprietario.nome||"N/D")+" | Area calculada: "+(data.areaCalculada!=null?Number(data.areaCalculada).toFixed(2)+" m2":"N/D"))+"</description>\n    <Style><LineStyle><color>ff0033b3</color><width>3</width></LineStyle><PolyStyle><color>4d0033b3</color></PolyStyle></Style>\n    <Polygon><outerBoundaryIs><LinearRing><coordinates>"+coords+"</coordinates></LinearRing></outerBoundaryIs></Polygon>\n  </Placemark>");
    (data.vertices||[]).forEach(function(v,i){var c=(data.coordsLngLat||[])[i];if(!c)return;placemarks.push("  <Placemark>\n    <name>"+xmlEscape(v.id)+"</name>\n    <Point><coordinates>"+c[0]+","+c[1]+",0</coordinates></Point>\n  </Placemark>");});
    return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n  <name>'+xmlEscape(nome)+"</name>\n"+placemarks.join("\n")+"\n</Document>\n</kml>\n";
  }
  function toCSV(data){
    var lines=[["Vertice","Easting","Northing","Latitude","Longitude","Azimute","Distancia","Confrontante"].join(";")];
    (data.vertices||[]).forEach(function(v){lines.push([v.id,v.easting,v.northing,v.latitude,v.longitude,v.azimute_para_proximo,v.distancia_para_proximo,v.confrontante_para_proximo].map(csvEscape).join(";"));});
    return lines.join("\n");
  }
  function toTXT(data){
    var m=data.matricula||{},p=data.proprietario||{},sc=data.sistemaCoordenadas||{},lines=[];
    lines.push("=".repeat(70),"INTEGRAL GEO MATRICULA - RELATORIO TECNICO","=".repeat(70),"","MATRICULA");
    lines.push("Numero: "+(m.numero||"N/D"),"Cartorio: "+(m.cartorio||"N/D"),"Comarca: "+(m.comarca||"N/D"),"Municipio: "+(m.municipio||"N/D"),"UF: "+(m.estado||"N/D"),"","PROPRIETARIO","Nome: "+(p.nome||"N/D"),"","GEORREFERENCIAMENTO");
    lines.push("Sistema: "+(sc.tipo||"N/D"),"Datum: "+(sc.datum||"N/D"),"EPSG: "+(sc.epsg||"N/D"),"Zona: "+(sc.zona||"N/D"),"Hemisferio: "+(sc.hemisferio||"N/D"),"","AREA E PERIMETRO");
    lines.push("Area registral: "+(data.areaRegistral!=null?Number(data.areaRegistral).toFixed(2)+" m2":"N/D"),"Area calculada: "+(data.areaCalculada!=null?Number(data.areaCalculada).toFixed(2)+" m2":"N/D"),"Perimetro calculado: "+(data.perimetroCalculado!=null?Number(data.perimetroCalculado).toFixed(2)+" m":"N/D"),"","VERTICES (ordem documental)","-".repeat(70));
    (data.vertices||[]).forEach(function(v){lines.push(v.id+" | E: "+(v.easting!=null?v.easting:v.longitude!=null?v.longitude:"N/D")+" | N: "+(v.northing!=null?v.northing:v.latitude!=null?v.latitude:"N/D")+" | Dist. prox.: "+(v.distancia_para_proximo!=null?v.distancia_para_proximo+" m":"N/D")+" | Azimute: "+(v.azimute_para_proximo||"N/D")+" | Confrontante: "+(v.confrontante_para_proximo||"N/D"));});
    lines.push("","ALERTAS","-".repeat(70));
    (data.alertas||[]).forEach(function(a){lines.push("["+String(a.nivel||"info").toUpperCase()+"] "+(a.mensagem||""));});
    lines.push("","Documento gerado automaticamente por INTEGRAL GEO MATRICULA.","Requer conferencia tecnica de um profissional habilitado.");
    return lines.join("\n");
  }
  function toGeoJSONMulti(docs){
    return {type:"FeatureCollection",features:(docs||[]).filter(function(d){return d.coordsLngLat&&d.coordsLngLat.length>=3;}).map(function(d){return toGeoJSON(d).features[0];})};
  }
  function toKMLMulti(docs,nomeProjeto){
    var folders=(docs||[]).filter(function(d){return d.coordsLngLat&&d.coordsLngLat.length>=3;}).map(function(d){var inner=toKML(d),match=inner.match(/<Document>([\s\S]*)<\/Document>/),body=match?match[1]:"",nome="Matricula "+(d.matricula&&d.matricula.numero||"s/n");return "  <Folder>\n    <name>"+xmlEscape(nome)+"</name>\n"+body+"\n  </Folder>";});
    return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n  <name>'+xmlEscape(nomeProjeto||"Projeto")+"</name>\n"+folders.join("\n")+"\n</Document>\n</kml>\n";
  }
  function toCSVMulti(docs){
    var lines=[["Matricula","Vertice","Easting","Northing","Latitude","Longitude","Azimute","Distancia","Confrontante"].join(";")];
    (docs||[]).forEach(function(d){var numero=d.matricula&&d.matricula.numero||"s/n";(d.vertices||[]).forEach(function(v){lines.push([numero,v.id,v.easting,v.northing,v.latitude,v.longitude,v.azimute_para_proximo,v.distancia_para_proximo,v.confrontante_para_proximo].map(csvEscape).join(";"));});});
    return lines.join("\n");
  }
  function toTXTProjeto(nomeProjeto,docs,matriculasCitadas){
    var lines=["=".repeat(70),"INTEGRAL GEO MATRICULA - RELATORIO DE PROJETO","Projeto: "+(nomeProjeto||"s/nome"),"Documentos: "+(docs||[]).length,"=".repeat(70)];
    (docs||[]).forEach(function(d){lines.push("",toTXT(d));if(d.situacaoMatricula&&d.situacaoMatricula.ativa===false)lines.push("","[ATENCAO] Esta matricula consta como substituida"+(d.situacaoMatricula.substituida_por?" pela matricula "+d.situacaoMatricula.substituida_por:"")+".");});
    if(matriculasCitadas&&matriculasCitadas.length){lines.push("","=".repeat(70),"MATRICULAS CITADAS NO PROJETO (nao analisadas)","-".repeat(70));matriculasCitadas.forEach(function(m){lines.push(m.numero+(m.contexto?" - "+m.contexto:""));});}
    lines.push("","Documento gerado automaticamente por INTEGRAL GEO MATRICULA.","Requer conferencia tecnica de um profissional habilitado.");
    return lines.join("\n");
  }

  return {toGeoJSON:toGeoJSON,toKML:toKML,toCSV:toCSV,toTXT:toTXT,toGeoJSONMulti:toGeoJSONMulti,toKMLMulti:toKMLMulti,toCSVMulti:toCSVMulti,toTXTProjeto:toTXTProjeto};
});

// Interface consolidada de multiplas matriculas. Mantida em modulo separado
// para nao misturar a logica de leitura/geometria com a apresentacao.
if(typeof window!=="undefined"&&typeof document!=="undefined"){
  (function(){
    var s=document.createElement("script");
    s.src="multi-matriculas.js";
    s.async=false;
    document.head.appendChild(s);
  })();
}
