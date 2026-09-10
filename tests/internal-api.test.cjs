const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../backend/server.cjs');
const { openDatabase, createUser, backup } = require('../backend/database.cjs');
// Native HTTP preserves the proxy Host header; fetch may replace this forbidden browser header.
const http=require('node:http');
function fetch(url,options={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method:options.method||'GET',headers:options.headers},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,headers:{get:name=>{
        const value=res.headers[name.toLowerCase()];return Array.isArray(value)?value.join(', '):value;
      }},json:async()=>JSON.parse(body),text:async()=>body}));
    });req.on('error',reject);req.end(options.body);
  });
}

test('internal API: authentication, isolation, validation, audit and backups', async t => {
  const db = openDatabase(':memory:');
  const password = 'Password-only-for-tests!';
  const a = await createUser(db,{email:'a@example.test',nome:'A',password,teams:['A']});
  const b = await createUser(db,{email:'b@example.test',nome:'B',password,teams:['B']});
  await createUser(db,{email:'chief@example.test',nome:'Chefia',password,perfil:'Chefia'});
  const app = createApp({db,production:false,origin:'http://127.0.0.1:3000'});
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const url = 'http://127.0.0.1:'+server.address().port;
  function client(){
    let cookie='',csrf='';
    return { get cookie(){return cookie}, async request(route,method='GET',body,extra={}){
      const res=await fetch(url+route,{method,headers:{host:'127.0.0.1:3000',cookie,'content-type':'application/json','x-csrf-token':csrf,...extra},body:body===undefined?undefined:JSON.stringify(body)});
      if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];
      const data=res.headers.get('content-type')?.includes('application/json')?await res.json():await res.text();
      if(data.csrf)csrf=data.csrf;
      return {status:res.status,data,headers:res.headers};
    }, async login(email){await this.request('/api/session');return this.request('/api/login','POST',{email,password})} };
  }
  const A=client(),B=client(),chief=client(),anon=client();
  const payload={data:'2026-09-09',turno:'Diurno',equipe:'A',coordenador:'A',integrantes:['A'],faltas:[],dia:['Demanda'],proximo:[],ocorrencias:[]};
  let record;
  try {
    await t.test('unauthenticated API is denied; private files and signup are not public',async()=>{
      assert.equal((await anon.request('/api/reports?start=2026-09-01&end=2026-09-30')).status,401);
      for(const route of ['/data/relatorios.sqlite','/config.js','/backend/server.cjs','/.git/config','/supabase/schema.sql','/Relat%C3%B3rio%20de%20Plant%C3%A3o.dc.html'])assert.equal((await anon.request(route)).status,404);
      await anon.request('/api/session');
      assert.equal((await anon.request('/api/signup','POST',{})).status,404);
      const page=await anon.request('/');assert.equal(page.status,200);assert.ok(!page.data.includes('supabase-js'));
    });
    await t.test('login rotates cookie; passwords are hashed; CSRF and origins are enforced',async()=>{
      await A.request('/api/session');const previous=A.cookie;
      assert.equal((await A.request('/api/login','POST',{email:'a@example.test',password},{'x-csrf-token':''})).status,403);
      assert.equal((await A.request('/api/login','POST',{email:'a@example.test',password},{origin:'https://attacker.test'})).status,403);
      assert.equal((await A.login('a@example.test')).status,200);assert.notEqual(A.cookie,previous);
      assert.notEqual(db.prepare('SELECT password_hash FROM users WHERE id=?').get(a).password_hash,password);
      assert.equal((await B.login('b@example.test')).status,200);
      assert.equal((await chief.login('chief@example.test')).status,200);
    });
    await t.test('author is determined by server; other users cannot read or change reports',async()=>{
      const saved=await A.request('/api/reports','POST',{...payload,autor_id:b});assert.equal(saved.status,201);record=saved.data;
      const rows=(await A.request('/api/reports?start=2026-09-01&end=2026-09-30')).data;assert.equal(rows.count,1);assert.equal(rows.data[0].autor_id,a);
      assert.equal((await B.request('/api/reports?start=2026-09-01&end=2026-09-30')).data.count,0);
      assert.equal((await B.request('/api/reports/'+record.id,'PUT',{...payload,equipe:'B',updated_at:record.updated_at})).status,404);
      assert.equal((await A.request('/api/reports','POST',{...payload,data:'2026-09-10',equipe:'B'})).status,403);
    });
    await t.test('invalid records, duplicate keys and stale versions cannot overwrite data',async()=>{
      for(const change of [{data:'2026-02-30'},{dia:[{}]},{ocorrencias:[{hora:'99:00',gravidade:'Alta',texto:'x'}]}])assert.equal((await A.request('/api/reports','POST',{...payload,...change})).status,400);
      assert.equal((await A.request('/api/reports','POST',payload)).status,409);
      const update=await chief.request('/api/reports/'+record.id,'PUT',{...payload,coordenador:'Chefia',updated_at:record.updated_at,autor_id:b});assert.equal(update.status,200);
      assert.equal((await A.request('/api/reports/'+record.id,'PUT',{...payload,updated_at:record.updated_at})).status,409);
      assert.equal(db.prepare('SELECT autor_id FROM reports WHERE id=?').get(record.id).autor_id,a);
      record=update.data;
    });
    await t.test('audit includes before/after and actor, and deletion is unavailable',async()=>{
      assert.equal((await A.request('/api/reports/'+record.id+'/audit')).status,403);
      const audit=(await chief.request('/api/reports/'+record.id+'/audit')).data;assert.equal(audit.length,2);
      assert.equal(JSON.parse(audit[0].previous_data).coordenador,'A');
      assert.equal(JSON.parse(audit[0].next_data).coordenador,'Chefia');
      assert.equal((await chief.request('/api/reports/'+record.id,'DELETE')).status,404);
      assert.throws(()=>db.exec('DELETE FROM audit'),/Immutable audit/);
    });
    await t.test('memberships and disabled accounts take effect immediately',async()=>{
      db.prepare('DELETE FROM memberships WHERE user_id=?').run(a);
      assert.equal((await A.request('/api/reports','POST',{...payload,data:'2026-09-12'})).status,403);
      db.prepare('UPDATE users SET active=0 WHERE id=?').run(b);
      assert.equal((await B.request('/api/reports?start=2026-09-01&end=2026-09-30')).status,401);
    });
    await t.test('logout invalidates server session and expired sessions cannot be used',async()=>{
      const previous=A.cookie;
      assert.equal((await A.request('/api/logout','POST',{})).status,200);
      assert.equal((await anon.request('/api/reports?start=2026-09-01&end=2026-09-30','GET',undefined,{cookie:previous})).status,401);
      db.exec('UPDATE sessions SET expires=0');
      assert.equal((await chief.request('/api/reports?start=2026-09-01&end=2026-09-30')).status,401);
    });
    await t.test('backup reopens with reports, accounts and audit intact',async()=>{
      const folder=fs.mkdtempSync(path.join(os.tmpdir(),'plantao-backup-test-'));const file=path.join(folder,'backup.sqlite');
      await backup(db,file);
      const {DatabaseSync}=require('node:sqlite');const restored=new DatabaseSync(file,{readOnly:true});
      try {assert.equal(restored.prepare('SELECT count(*) AS n FROM reports').get().n,1);assert.equal(restored.prepare('SELECT count(*) AS n FROM audit').get().n,2);assert.equal(restored.prepare('SELECT count(*) AS n FROM users').get().n,3)}
      finally{restored.close();fs.unlinkSync(file);fs.rmdirSync(folder)}
    });
    await t.test('rate limit is persistent and repeated bad logins are blocked',async()=>{
      const attacker=client();await attacker.request('/api/session');
      for(let i=0;i<10;i++)assert.equal((await attacker.request('/api/login','POST',{email:'nobody@example.test',password:'wrong'})).status,401);
      assert.equal((await attacker.request('/api/login','POST',{email:'nobody@example.test',password:'wrong'})).status,429);
    });
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()}
});

test('production requires HTTPS origin and sets secure cookies behind local proxy',async()=>{
  const db=openDatabase(':memory:');
  assert.throws(()=>createApp({db,production:true,origin:'http://example.test'}),/HTTPS/);
  const app=createApp({db,production:true,origin:'https://example.test:5000'});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const url='http://127.0.0.1:'+server.address().port+'/api/session';
    assert.equal((await fetch(url,{headers:{host:'example.test:5000'}})).status,400);
    const res=await fetch(url,{headers:{host:'example.test:5000','x-forwarded-proto':'https'}});
    assert.equal(res.status,200);assert.match(res.headers.get('set-cookie'),/HttpOnly/);assert.match(res.headers.get('set-cookie'),/Secure/);assert.match(res.headers.get('set-cookie'),/SameSite=Strict/);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()}
});
