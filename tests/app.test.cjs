const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/init\(\);\s*$/,'');
function harness(handler=async()=>({data:[],count:0}),date){
  const el={innerHTML:''},timers=[],calls=[];
  const ctx={console,URL,window:{addEventListener(){}},document:{getElementById:()=>el,addEventListener(){}},confirm:()=>true,
    setTimeout:fn=>timers.push(fn),clearTimeout(){},fetch:async(url,options)=>{calls.push({url,options});const result=await handler(url,options);return {ok:!result.error,status:result.status||200,json:async()=>result}}};
  if(date)ctx.Date=class extends Date{constructor(...args){super(...(args.length?args:[date]))}};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const run=code=>vm.runInContext(code,ctx);
  run("state.loading=false;state.user={id:'A'};state.profile={id:'A',nome:'A',perfil:'Supervisor'};state.teams=['A'];state.form.equipe='A';state.refDate='2026-09-09'");
  return {run,ctx,el,timers,calls};
}
test('registration form submits Supervisor details then logs in',async()=>{
  const h=harness(url=>url==='/api/register'?{ok:true}:url==='/api/login'?{user:{id:'new',nome:'Novo',perfil:'Supervisor'},teams:['B'],csrf:'new'}:{data:[],count:0});
  h.run("state.authMode='access';state.authEmail='new@example.test';state.authName='Novo';state.authTeam='B';state.authPass='Test-password-123'");
  const markup=h.run('authView()');assert.ok(markup.includes('register-name'));assert.ok(markup.includes('register-team'));assert.ok(markup.includes('minlength="12"'));
  await h.run('loginOrSignup()');
  assert.equal(h.calls[0].url,'/api/register');assert.equal(JSON.parse(h.calls[0].options.body).equipe,'B');
  assert.equal(h.calls[1].url,'/api/login');assert.equal(h.run('state.authPass'),'');assert.equal(h.run('isChief()'),false);
});
test('Sao Paulo date does not advance after 21h',()=>assert.equal(harness(undefined,'2026-09-09T21:30:00-03:00').run('today()'),'2026-09-09'));
test('CSV neutralizes formulas and quotes',()=>{
  const h=harness();for(const text of ['=1','+1','-1','@SUM(A1)','  =1','\ttext','\rtext','\ntext','\uFF1D1']){h.ctx.value=text;assert.ok(h.run('csvCell(value)').startsWith(String.fromCharCode(34,39)))}
  h.ctx.value='Equipe "A"';assert.equal(h.run('csvCell(value)'),'"Equipe ""A"""');
});
test('old account response cannot restore private data after logout',async()=>{
  let finish;
  const h=harness(url=>url.startsWith('/api/reports')?new Promise(resolve=>finish=resolve):Promise.resolve({user:null,teams:[],csrf:'new'}));
  h.run("state.form.dia=['PRIVATE'];state.authPass='secret';state.editing={id:'old'}");const pending=h.run('loadRecords()');
  await h.run('logout()');finish({data:[{id:'PRIVATE'}],count:1});await pending;
  assert.equal(h.run('state.user'),null);assert.equal(h.run('state.records.length'),0);assert.equal(h.run('state.authPass'),'');assert.equal(h.run("JSON.stringify(state.form).includes('PRIVATE')"),false);
});
test('all period pages load even with a smaller server page limit',async()=>{
  const h=harness(url=>{const offset=Number(new URL(url,'http://test').searchParams.get('offset'));return {data:Array.from({length:Math.min(100,1105-offset)},(_,i)=>({id:offset+i})),count:1105}});
  await h.run('loadRecords()');assert.equal(h.run('state.records.length'),1105);assert.equal(h.calls.length,12);assert.match(h.calls[0].url,/start=2026-09-07&end=2026-09-13/);
});
test('failed pages never display or export partial totals',async()=>{
  const h=harness(()=>({error:'fail',status:500}));await h.run('loadRecords()');assert.equal(h.run('state.records.length'),0);assert.ok(h.run('state.recordsError'));
  h.run("state.profile.perfil='Chefia';exportCsv()");assert.match(h.run('consolidatedView()'),/periodo completo/);
});
test('update sends loaded version without client supplied author',async()=>{
  const h=harness((url,options)=>options.method==='PUT'?{id:'record',updated_at:'next'}:{data:[],count:0});
  h.run("state.editing={id:'record',updated_at:'old'};state.dirty=true");await h.run('saveRecord()');
  const body=JSON.parse(h.calls[0].options.body);assert.equal(body.updated_at,'old');assert.equal('autor_id' in body,false);assert.equal(h.run('state.dirty'),false);
});
test('conflict preserves unsaved draft',async()=>{
  const h=harness(()=>({error:'Este plantao mudou.',status:409}));h.run("state.editing={id:'r',updated_at:'old'};state.dirty=true;state.form.dia=['work']");await h.run('saveRecord()');assert.equal(h.run('state.dirty'),true);assert.equal(h.run('state.form.dia[0]'),'work');assert.match(h.run('state.error'),/mudou/);
});
test('unauthorized response clears private state immediately',async()=>{
  const h=harness(()=>({error:'Sua sessao expirou.',status:401}));h.run("state.form.dia=['private']");await h.run('loadRecords()');assert.equal(h.run('state.user'),null);assert.equal(h.run("state.form.dia.includes('private')"),false);
});
test('same-account focus refresh preserves draft; different account clears it',async()=>{
  const h=harness();h.ctx.session={user:{id:'A',nome:'A',perfil:'Supervisor'},teams:['A'],csrf:'csrf',expires:Date.now()+10000};h.run("state.form.dia=['private']");await h.run('acceptSession(session)');assert.equal(h.run('state.form.dia[0]'),'private');h.ctx.session.user.id='B';await h.run('acceptSession(session)');assert.equal(h.run("state.form.dia.includes('private')"),false);
});
test('login sends CSRF and clears password; UI no longer requires Supabase',async()=>{
  const h=harness((url,opts)=>url==='/api/login'?{user:{id:'B',nome:'B',perfil:'Supervisor'},teams:['B'],csrf:'new',expires:Date.now()+10000}:{data:[],count:0});
  h.run("csrfToken='csrf';state.authEmail='b@example.test';state.authPass='test-password'");await h.run('loginOrSignup()');assert.equal(h.calls[0].options.headers['X-CSRF-Token'],'csrf');assert.equal(h.run('state.authPass'),'');assert.equal(h.run('state.user.id'),'B');assert.equal(h.run('authView()').includes('Supabase'),false);
});
test('report views escape input and render valid event handlers',()=>{
  const h=harness();h.run("state.form.dia=['<script>alert(1)</script>'];state.records=[{...state.form,id:'abc',updated_at:'v1'}]");
  for(const view of ['authView()','formView()','reportView()','consolidatedView()']){
    const html=h.run(view);assert.equal(html.includes('<script>alert'),false);
    for(const match of html.matchAll(/\bon(?:click|input|change|submit)="([^"]*)"/g))assert.doesNotThrow(()=>new vm.Script('(function(event){'+match[1]+'})'));
  }
});
