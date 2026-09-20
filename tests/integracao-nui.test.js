const test=require('node:test'),assert=require('node:assert/strict');
const handler=require('../api/integracao-nui');
const res=()=>({statusCode:0,setHeader(){},status(c){this.statusCode=c;return this;},json(d){this.data=d;return this;}});
test('sem sessão não consulta IA',async()=>{const r=res();await handler({method:'POST',headers:{}},r);assert.equal(r.statusCode,401);});
test('perfil comercial não chama extração; projetos recebe resultado e hash',async()=>{
 const original=global.fetch,old=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='test-only';let role='Comercial',ai=0;
 global.fetch=async(url,options)=>{
  if(url.endsWith('/user'))return Response.json({id:'00000000-0000-4000-8000-000000000001'});
  if(url.includes('/profiles?'))return Response.json([{tipo:role,ativo:true}]);
  if(url.includes('integracao_reservar_leitura'))return Response.json(null);
  ai++;const payload=JSON.parse(options.body);assert.equal(payload.tools[0].name,'extrair_dados_matricula');assert.ok(payload.tools[0].input_schema.properties.evidencias);return Response.json({stop_reason:'tool_use',content:[{type:'tool_use',name:'extrair_dados_matricula',input:{matricula:{numero:'123'},historico_registro:[]}}]});
 };
 try{const req={method:'POST',headers:{authorization:'Bearer test-only'},body:{arquivo:'ficticio.pdf',mime:'application/pdf',base64:Buffer.from('%PDF-1.4\nfixture').toString('base64')}};const negado=res();await handler(req,negado);assert.equal(negado.statusCode,403);assert.equal(ai,0);role='Projetos';const ok=res();await handler(req,ok);assert.equal(ok.statusCode,200);assert.equal(ok.data.hash.length,64);assert.equal(ai,1);
 const invalido=res();await handler({...req,body:{...req.body,base64:'YWJj'}},invalido);assert.equal(invalido.statusCode,400);assert.equal(ai,1);
 }finally{global.fetch=original;if(old===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=old;}
});
