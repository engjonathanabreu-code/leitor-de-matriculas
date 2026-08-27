(function(){
  "use strict";

  var PROJECTS_KEY = "integral-geo-matricula:projetos";
  var ACTIVE_PROJECT_KEY = "integral-geo-matricula:projeto-ativo";

  function esc(v){
    if(v==null)return "";
    return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;");
  }

  function activeProject(){
    try{
      var projetos=JSON.parse(localStorage.getItem(PROJECTS_KEY)||"[]");
      var id=localStorage.getItem(ACTIVE_PROJECT_KEY);
      return projetos.filter(function(p){return p.id===id;})[0]||projetos[0]||null;
    }catch(e){return null;}
  }

  function fmtArea(v,unidade){
    if(v==null||isNaN(v))return "N/D";
    return Number(v).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})+" "+(unidade||"m²");
  }

  function fmtLen(v){
    if(v==null||isNaN(v))return "N/D";
    return Number(v).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})+" m";
  }

  function piorNivel(validacoes){
    var rank={ok:0,atencao:1,erro:2};
    return (validacoes||[]).reduce(function(acc,v){return rank[v.nivel]>rank[acc]?v.nivel:acc;},"ok");
  }

  function badgeInfo(doc){
    var pior=piorNivel(doc.validacoes);
    if(pior==="erro")return {cls:"rs-badge--error",txt:"✕ Erro geométrico"};
    if(pior==="atencao")return {cls:"rs-badge--warn",txt:"⚠ Atenção"};
    return {cls:"rs-badge--ok",txt:"✓ Poligonal válida"};
  }

  function compare(areaRegistral,areaCalculada){
    if(areaRegistral==null||areaCalculada==null||isNaN(areaRegistral)||isNaN(areaCalculada))return null;
    var diferenca=Number(areaCalculada)-Number(areaRegistral);
    return {diferenca:diferenca,percentual:Number(areaRegistral)!==0?(diferenca/Number(areaRegistral))*100:0};
  }

  function metric(label,value,extraClass){
    return '<div><div class="rs-metric-label">'+esc(label)+'</div><div class="rs-metric-value '+(extraClass||"")+'">'+esc(String(value))+'</div></div>';
  }

  function docSummary(doc){
    var d=doc.extraido||{},m=d.matricula||{},im=d.imovel||{},numero=m.numero||doc.nomeArquivo||"s/n";
    var cmp=compare(im.area_registral,doc.areaCalculada),badge=badgeInfo(doc),html="";
    html+='<section class="card multi-matricula-result">';
    html+='<div class="multi-matricula-head"><div class="multi-matricula-title"><span class="color-dot" style="background:'+esc(doc.cor||"#1d4ed8")+'"></span><h2>Matrícula '+esc(numero)+'</h2></div><span class="rs-badge '+badge.cls+'">'+badge.txt+'</span></div>';
    if(doc.situacaoMatricula&&doc.situacaoMatricula.ativa===false){
      html+='<div class="substituicao-banner">⚠ Esta matrícula consta como substituída'+(doc.situacaoMatricula.substituida_por?' pela matrícula <b>'+esc(doc.situacaoMatricula.substituida_por)+'</b>':'')+'.</div>';
    }
    html+='<div class="rs-grid">';
    html+=metric("Vértices identificados",(doc.vertices||[]).length);
    html+=metric("Sistema",((doc.sistema&&doc.sistema.datum)||"N/D")+(doc.sistema&&doc.sistema.zona?' · UTM '+doc.sistema.zona+(doc.sistema.hemisferio||''):''));
    html+=metric("Área registral",im.area_registral!=null?fmtArea(im.area_registral,im.unidade_area):"N/D");
    html+=metric("Área calculada",doc.areaCalculada!=null?fmtArea(doc.areaCalculada):"N/D",cmp?(cmp.diferenca<0?"negative":"positive"):"");
    if(cmp)html+=metric("Diferença",fmtArea(cmp.diferenca)+" ("+cmp.percentual.toFixed(3)+"%)",cmp.diferenca<0?"negative":"positive");
    html+=metric("Perímetro calculado",doc.perimetroCalculado!=null?fmtLen(doc.perimetroCalculado):"N/D");
    html+='</div></section>';
    return html;
  }

  function renderCombinedSummary(){
    var project=activeProject(),el=document.getElementById("result-summary");
    if(!el||!project||!project.documentos||!project.documentos.length)return;
    var docs=project.documentos;
    var html='<div class="multi-result-header"><div><p class="rs-title">Resultado da análise</p><h2>'+docs.length+' matrícula'+(docs.length>1?'s':'')+' analisada'+(docs.length>1?'s':'')+'</h2><p class="multi-result-sub">Os resultados abaixo pertencem ao mesmo projeto e foram mantidos separados por matrícula.</p></div></div>';
    html+='<div class="multi-result-list">'+docs.map(docSummary).join('')+'</div>';
    html+='<div class="rs-actions multi-result-actions"><button class="btn btn-secondary" data-multi-go="dados-extraidos">Ver dados extraídos</button><button class="btn btn-secondary" data-multi-go="mapa">Ver mapa conjunto</button><button class="btn btn-secondary" data-multi-go="validacao">Ver validação</button><button class="btn btn-primary" style="width:auto;margin:0" data-multi-go="exportacao">Exportar</button></div>';
    el.innerHTML=html;
    el.hidden=false;
    el.querySelectorAll('[data-multi-go]').forEach(function(btn){btn.addEventListener('click',function(){if(window.IntegralApp)window.IntegralApp.goToView(btn.dataset.multiGo);});});
  }

  function panelTable(title,rows){
    var html='<div class="card data-panel"><h3>'+esc(title)+'</h3><table class="data-table report-table"><tbody>';
    rows.forEach(function(r){var value=r[1],isNull=value==null||value==="";html+='<tr><td class="report-label">'+esc(r[0])+'</td><td class="report-value'+(isNull?' is-null':'')+'">'+(isNull?'não identificado':esc(String(value)))+'</td></tr>';});
    return html+'</tbody></table></div>';
  }

  function renderDocFull(doc){
    var d=doc.extraido||{},m=d.matricula||{},p=d.proprietario||{},im=d.imovel||{},sc=doc.sistema||{},numero=m.numero||doc.nomeArquivo||"s/n",badge=badgeInfo(doc),cmp=compare(im.area_registral,doc.areaCalculada),html='';
    html+='<article class="multi-dados-doc">';
    html+='<div class="card doc-header-card"><div class="multi-matricula-head"><div class="multi-matricula-title"><span class="color-dot" style="background:'+esc(doc.cor||"#1d4ed8")+'"></span><h2>Matrícula '+esc(numero)+'</h2></div><div class="multi-badges">';
    html+=doc.situacaoMatricula&&doc.situacaoMatricula.ativa===false?'<span class="rs-badge rs-badge--warn">Substituída</span>':'<span class="rs-badge rs-badge--ok">Ativa</span>';
    html+='<span class="rs-badge '+badge.cls+'">'+badge.txt+'</span></div></div><div class="rs-grid" style="margin-top:16px;">';
    html+=metric("Área registral",im.area_registral!=null?fmtArea(im.area_registral,im.unidade_area):"N/D");
    html+=metric("Área calculada",doc.areaCalculada!=null?fmtArea(doc.areaCalculada):"N/D",cmp?(cmp.diferenca<0?"negative":"positive"):"");
    if(cmp)html+=metric("Diferença",fmtArea(cmp.diferenca)+" ("+cmp.percentual.toFixed(3)+"%)",cmp.diferenca<0?"negative":"positive");
    html+=metric("Perímetro calculado",doc.perimetroCalculado!=null?fmtLen(doc.perimetroCalculado):"N/D");
    html+=metric("Vértices",(doc.vertices||[]).length);
    html+='</div></div>';
    if(doc.situacaoMatricula&&doc.situacaoMatricula.ativa===false){html+='<div class="substituicao-banner">⚠ O texto deste documento indica que esta matrícula foi substituída'+(doc.situacaoMatricula.substituida_por?' pela matrícula <b>'+esc(doc.situacaoMatricula.substituida_por)+'</b>':' por outra matrícula (número não identificado)')+'.</div>';}
    html+='<div class="data-grid">';
    html+=panelTable("Matrícula",[["Número",m.numero],["Cartório",m.cartorio],["Comarca",m.comarca],["Município",m.municipio],["UF",m.estado]]);
    html+=panelTable("Proprietário",[["Nome",p.nome],["CPF",p.cpf],["CNPJ",p.cnpj]]);
    html+=panelTable("Imóvel",[["Área registral",im.area_registral!=null?fmtArea(im.area_registral,im.unidade_area):null],["Endereço",im.endereco],["Lote",im.lote],["Quadra",im.quadra]]);
    html+=panelTable("Georreferenciamento",[["Sistema",sc.tipo],["Datum",sc.datum],["EPSG",sc.epsg],["Zona",sc.zona],["Hemisfério",sc.hemisferio],["Número de vértices",(doc.vertices||[]).length]]);
    html+='</div>';
    html+='<div class="card evidence-list"><h3>Evidência textual (auditoria)</h3>';
    if(!(doc.vertices||[]).length)html+='<p class="empty-state-inline">Nenhum vértice identificado.</p>';
    (doc.vertices||[]).forEach(function(v){var conf=Math.round((v.confianca||0)*100),cls=v.confianca>=.9?'confidence-high':v.confianca>=.7?'confidence-medium':'confidence-low';html+='<div class="evidence-item"><div class="evidence-item-head"><span class="evidence-vertex">'+esc(v.id)+'</span><span class="evidence-confidence '+cls+'">'+conf+'%</span></div><p class="evidence-text">'+(v.texto_origem?esc(v.texto_origem):'Sem trecho de origem registrado.')+'</p></div>';});
    html+='</div>';
    if(doc.alertasIA&&doc.alertasIA.length){html+='<div class="card"><h3>Alertas da leitura</h3><table class="data-table report-table"><tbody>';doc.alertasIA.forEach(function(a,i){html+='<tr><td class="report-label" style="width:auto;font-family:var(--font-mono);font-weight:700;">'+(i+1)+'</td><td class="report-value" style="font-family:var(--font-sans);font-weight:400;text-align:left;">'+esc(a)+'</td></tr>';});html+='</tbody></table></div>';}
    if(doc.matriculasCitadas&&doc.matriculasCitadas.length){html+='<div class="card"><h3>Matrículas citadas neste documento</h3><table class="data-table report-table"><tbody>';doc.matriculasCitadas.forEach(function(c){html+='<tr><td class="report-label" style="width:auto;font-family:var(--font-mono);font-weight:700;">'+esc(c.numero)+'</td><td class="report-value" style="font-family:var(--font-sans);font-weight:400;text-align:left;">'+esc(c.contexto||'')+'</td></tr>';});html+='</tbody></table></div>';}
    return html+'</article>';
  }

  function renderCombinedDados(){
    var project=activeProject(),container=document.getElementById('dados-extraidos-content'),selector=document.getElementById('dados-extraidos-seletor');
    if(!container||!project||!project.documentos||!project.documentos.length)return;
    if(selector){selector.hidden=true;selector.innerHTML='';}
    container.className='';
    container.innerHTML='<div class="multi-dados-intro"><strong>Análise conjunta do projeto</strong><span>'+project.documentos.length+' matrícula'+(project.documentos.length>1?'s':'')+'</span></div>'+project.documentos.map(renderDocFull).join('');
  }

  function injectStyles(){
    if(document.getElementById('multi-matriculas-styles'))return;
    var s=document.createElement('style');
    s.id='multi-matriculas-styles';
    s.textContent='.multi-result-header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:14px}.multi-result-header h2{margin:2px 0 4px}.multi-result-sub{margin:0;color:var(--muted);font-size:13px}.multi-result-list{display:grid;gap:14px}.multi-matricula-result{box-shadow:none}.multi-matricula-head{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px}.multi-matricula-title{display:flex;align-items:center;gap:10px}.multi-matricula-title h2{margin:0;font-size:20px}.multi-badges{display:flex;gap:8px;flex-wrap:wrap}.multi-result-actions{margin-top:16px}.multi-dados-intro{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 14px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text)}.multi-dados-intro span{color:var(--muted);font-size:13px}.multi-dados-doc{display:grid;gap:14px;margin-bottom:30px;padding-bottom:30px;border-bottom:2px solid var(--border)}.multi-dados-doc:last-child{border-bottom:0;margin-bottom:0;padding-bottom:0}@media(max-width:700px){.multi-result-header,.multi-dados-intro{align-items:flex-start;flex-direction:column}}';
    document.head.appendChild(s);
  }

  function init(){
    injectStyles();
    var status=document.getElementById('status-pill');
    if(status){
      new MutationObserver(function(){var t=status.textContent||'';if(/Analise concluida|Análise concluída|Concluido com erros|Concluído com erros/i.test(t)){setTimeout(renderCombinedSummary,0);}}).observe(status,{childList:true,characterData:true,subtree:true,attributes:true});
    }
    document.addEventListener('click',function(e){var btn=e.target.closest&&e.target.closest('.nav-item[data-view="dados-extraidos"]');if(btn)setTimeout(renderCombinedDados,0);});
    var sel=document.getElementById('seletor-projeto');if(sel)sel.addEventListener('change',function(){setTimeout(function(){if(document.getElementById('view-dados-extraidos').classList.contains('active'))renderCombinedDados();},0);});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(init,0);});else setTimeout(init,0);
})();
