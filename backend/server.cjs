const express = require('express');
const helmet = require('helmet');
const crypto = require('node:crypto');
const path = require('node:path');
const { openDatabase, verifyPassword, createUser, transaction, serialize } = require('./database.cjs');
const root = path.join(__dirname, '..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const fail = (status, message) => Object.assign(new Error(message), { status });
const dummyHash = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
function validatePayload(body) {
  const p = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400,'Relatorio invalido.');
  if (!validDate(body.data) || !['Diurno','Noturno'].includes(body.turno)) throw fail(400,'Confira data e turno.');
  p.data = body.data; p.turno = body.turno;
  function text(v, max, required = false) {
    if (typeof v !== 'string' || v.length > max || (required && !v.trim())) throw fail(400,'Confira os campos do relatorio.');
    return v.trim();
  }
  p.equipe = text(body.equipe,120,true); p.coordenador = text(body.coordenador,200);
  for (const key of ['integrantes','dia','proximo','faltas','ocorrencias']) {
    if (!Array.isArray(body[key]) || body[key].length > 500) throw fail(400,'Lista invalida ou muito extensa.');
    p[key] = body[key].map(item => {
      if (['integrantes','dia','proximo'].includes(key)) return text(item,10000,true);
      if (!item || typeof item !== 'object') throw fail(400,'Item invalido.');
      if (key === 'faltas') return { nome: text(item.nome,200,true), motivo: text(item.motivo,10000) };
      if (!['Baixa','Media','Alta'].includes(item.gravidade) || typeof item.hora !== 'string' || !/^$|^([01]\d|2[0-3]):[0-5]\d$/.test(item.hora)) throw fail(400,'Confira a ocorrencia.');
      return { hora: item.hora, gravidade: item.gravidade, texto: text(item.texto,10000,true) };
    });
  }
  return p;
}

function createApp(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const origin = options.origin ?? process.env.APP_ORIGIN ?? 'http://127.0.0.1:3000';
  const parsed = new URL(origin);
  if (parsed.origin !== origin || (production && parsed.protocol !== 'https:')) throw new Error('APP_ORIGIN deve ser a origem HTTPS publica, sem barra final.');
  const db = options.db || openDatabase(process.env.DATABASE_PATH || path.join(root,'data','relatorios.sqlite'));
  const app = express();
  app.locals.db = db;
  app.disable('x-powered-by');
  // Only the local Apache reverse proxy may supply forwarded connection information.
  if (production) app.set('trust proxy', 'loopback');
  app.use(helmet({
    strictTransportSecurity: production ? { maxAge: 15552000, includeSubDomains: false } : false,
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: production ? [] : null,
    } }, referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use((req,res,next) => {
    res.set('Cache-Control','no-store');
    if (production && !req.secure) return res.status(400).json({error:'Acesso HTTPS obrigatorio.'});
    if (req.get('host') !== parsed.host) return res.status(400).json({error:'Endereco de acesso invalido.'});
    next();
  });
  app.use('/api',express.json({limit:'256kb',strict:true}));
  function newSession(res,userId = null) {
    const raw = token(), csrf = token(), expires = Date.now() + (userId ? 8 * 3600000 : 30 * 60000);
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(raw),userId,csrf,expires);
    res.cookie('plantao_session',raw,{httpOnly:true,secure:production,sameSite:'strict',path:'/',maxAge:expires-Date.now()});
    return {token_hash:digest(raw),user_id:userId,csrf,expires};
  }
  app.use('/api',(req,res,next) => {
    const raw = (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith('plantao_session='))?.slice(16);
    req.authSession = raw && db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires>?').get(digest(raw),Date.now());
    req.user = req.authSession?.user_id && db.prepare('SELECT id,email,nome,perfil FROM users WHERE id=? AND active=1 AND access_status=\'approved\'').get(req.authSession.user_id);
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if (req.get('origin') && req.get('origin') !== origin) return next(fail(403,'Origem nao autorizada.'));
      if (!req.authSession || req.get('x-csrf-token') !== req.authSession.csrf) return next(fail(403,'Sessao de seguranca expirada. Atualize a pagina.'));
    }
    next();
  });
  function requireUser(req,res,next) { if (!req.user) return next(fail(401,'Sua sessao expirou. Entre novamente.')); next(); }
  function requireChief(req,res,next) { if (!req.user) return next(fail(401,'Entre novamente.')); if(req.user.perfil!=='Chefia')return next(fail(403,'Acesso exclusivo da Chefia.'));next(); }
  app.use('/api/security',requireChief);
  function safeUser(id){const u=db.prepare('SELECT id,email,nome,perfil,active,access_status,requested_team,security_version,created_at FROM users WHERE id=?').get(id);return u?{...u,teams:teams(id)}:null;}
  app.get('/api/security/users',(req,res)=>{
    const offset=Number(req.query.offset||0);
    if(!Number.isSafeInteger(offset)||offset<0)throw fail(400,'Página inválida.');
    const users=db.prepare("SELECT id FROM users ORDER BY CASE access_status WHEN 'pending' THEN 0 ELSE 1 END,nome,id LIMIT 50 OFFSET ?").all(offset).map(u=>safeUser(u.id));
    res.json({users,count:db.prepare('SELECT count(*) AS n FROM users').get().n});
  });
  app.get('/api/security/audit',(req,res)=>{
    res.json({events:db.prepare(`SELECT a.id,a.action,a.occurred_at,a.previous_data,a.next_data,
      actor.nome AS actor,target.email AS target FROM security_audit a JOIN users actor ON actor.id=a.actor_id
      JOIN users target ON target.id=a.target_id ORDER BY a.id DESC LIMIT 50`).all()});
  });
  app.put('/api/security/users/:id',(req,res)=>{
    const {action,teams:allowed,version}=req.body||{};
    if(!['approve','block'].includes(action)||!Number.isSafeInteger(version))throw fail(400,'Ação inválida.');
    if(action==='approve'&&(!Array.isArray(allowed)||!allowed.length||allowed.length>30||allowed.some(t=>typeof t!=='string'||!t.trim()||t.trim().length>120)))throw fail(400,'Defina pelo menos uma equipe autorizada, até 30 equipes.');
    const result=transaction(db,()=>{
      const previous=safeUser(req.params.id);
      if(!previous)throw fail(404,'Usuário não encontrado.');
      if(previous.perfil!=='Supervisor')throw fail(403,'Este painel gerencia acessos de Supervisores.');
      if(previous.security_version!==version)throw fail(409,'O acesso foi alterado por outra pessoa. Atualize o painel.');
      const approved=action==='approve';
      db.prepare('UPDATE users SET active=?,access_status=?,security_version=security_version+1 WHERE id=?').run(approved?1:0,approved?'approved':'blocked',previous.id);
      db.prepare('DELETE FROM memberships WHERE user_id=?').run(previous.id);
      if(approved)for(const team of new Set(allowed.map(t=>t.trim())))db.prepare('INSERT INTO memberships VALUES (?,?)').run(previous.id,team);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(previous.id);
      const next=safeUser(previous.id);
      db.prepare('INSERT INTO security_audit(actor_id,target_id,action,occurred_at,previous_data,next_data) VALUES (?,?,?,?,?,?)').run(req.user.id,previous.id,action,new Date().toISOString(),JSON.stringify(previous),JSON.stringify(next));
      return next;
    });
    res.json({user:result});
  });
  function teams(id) { return db.prepare('SELECT equipe FROM memberships WHERE user_id=? ORDER BY equipe').all(id).map(r=>r.equipe); }
  function defaults(id) { const row=db.prepare('SELECT payload FROM user_defaults WHERE user_id=?').get(id); return row?JSON.parse(row.payload):null; }
  function sessionData(req) { return { user:req.user || null, teams:req.user ? teams(req.user.id) : [], defaults:req.user?defaults(req.user.id):null, csrf:req.authSession.csrf, expires:req.authSession.expires }; }
  app.put('/api/defaults',requireUser,(req,res) => {
    const {equipe,turno,signature}=req.body||{};
    if(typeof equipe!=='string'||equipe.length>120||(equipe&&!canWrite(req.user,equipe))||!['Diurno','Noturno'].includes(turno)||typeof signature!=='string'||signature.length>180000|| (signature && !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(signature))) throw fail(400,'Confira equipe, turno e assinatura PNG.');
    const value={equipe,turno,signature};
    db.prepare('INSERT INTO user_defaults VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload').run(req.user.id,JSON.stringify(value));
    res.json(value);
  });
  app.get('/api/groups',requireUser,(req,res)=>{
    const equipe=req.query.equipe;
    if(typeof equipe!=='string'||!equipe||!canWrite(req.user,equipe)) throw fail(403,'Equipe não autorizada.');
    const row=db.prepare('SELECT payload FROM team_groups WHERE equipe=?').get(equipe);
    res.json({groups:row?JSON.parse(row.payload):[],version:digest(row?.payload||'[]')});
  });
  app.put('/api/groups',requireUser,(req,res)=>{
    const {equipe,groups}=req.body||{};
    if(typeof equipe!=='string'||!equipe||equipe.length>120||!canWrite(req.user,equipe)) throw fail(403,'Equipe não autorizada.');
    if(!Array.isArray(groups)||groups.length>30) throw fail(400,'Limite de 30 grupos por equipe.');
    const old=db.prepare('SELECT payload FROM team_groups WHERE equipe=?').get(equipe);
    if(req.body.version!==digest(old?.payload||'[]')) throw fail(409,'Os grupos mudaram. Carregue novamente antes de salvar.');
    const normalized=groups.map(g=>{
      if(!g||typeof g.nome!=='string'||!g.nome.trim()||g.nome.length>120||!Array.isArray(g.integrantes)||g.integrantes.length>100||g.integrantes.some(n=>typeof n!=='string'||!n.trim()||n.length>200)) throw fail(400,'Informe o nome do grupo e até 100 integrantes.');
      return {nome:g.nome.trim(),integrantes:[...new Set(g.integrantes.map(n=>n.trim()))]};
    });
    db.prepare('INSERT INTO team_groups VALUES (?,?) ON CONFLICT(equipe) DO UPDATE SET payload=excluded.payload').run(equipe,JSON.stringify(normalized));
    res.json({groups:normalized,version:digest(JSON.stringify(normalized))});
  });
  app.get('/api/session',(req,res) => {
    if (!req.authSession || (req.authSession.user_id && !req.user)) {
      checkRate('sessions:'+digest(req.ip),120);
      req.authSession = newSession(res);
    }
    res.json(sessionData(req));
  });
  function checkRate(key,limit) {
    const now = Date.now();
    const row = db.prepare('SELECT * FROM attempts WHERE key=?').get(key);
    if (row && row.expires > now && row.count >= limit) throw fail(429,'Muitas tentativas. Aguarde 15 minutos.');
    db.prepare(`INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN expires>? THEN count+1 ELSE 1 END,
      expires=CASE WHEN expires>? THEN expires ELSE excluded.expires END`).run(key,now+900000,now,now);
  }
  app.post('/api/register',async (req,res) => {
    if (req.user) throw fail(409,'Saia da conta atual antes de cadastrar outra.');
    checkRate('register:'+digest(req.ip),5);
    const {email,nome,password,equipe} = req.body || {};
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || typeof nome !== 'string' || !nome.trim() || nome.length > 200 || typeof equipe !== 'string' || !equipe.trim() || equipe.trim().length > 120 || typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail(400,'Informe nome, e-mail, equipe e senha de 12 a 128 caracteres.');
    try {
      await createUser(db,{email,nome,password,perfil:'Supervisor',pending:true,requestedTeam:equipe.trim()});
    } catch(error) {
      if (error.message?.includes('UNIQUE constraint failed: users.email')) throw fail(409,'Não foi possível cadastrar esse e-mail. Tente entrar ou procure a administração.');
      throw error;
    }
    res.status(201).json({ok:true,pending:true,message:'Solicitação enviada. Aguarde a aprovação da Chefia para entrar.'});
  });
  app.post('/api/login',async (req,res) => {
    const {email,password} = req.body || {};
    if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 128) throw fail(400,'Informe e-mail e senha.');
    const normalized = email.trim().toLowerCase();
    checkRate('ip:'+digest(req.ip),60); checkRate('email:'+digest(normalized),10);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(normalized);
    if (!await verifyPassword(password,user?.password_hash || dummyHash) || !user) throw fail(401,'E-mail ou senha invalidos.');
    if(user.access_status==='pending')throw fail(403,'Seu cadastro aguarda aprovação da Chefia.');
    if(!user.active||user.access_status!=='approved')throw fail(403,'Acesso bloqueado. Procure a Chefia.');
    // The account may have been disabled or had its password reset while scrypt ran.
    const current = db.prepare('SELECT id,email,nome,perfil FROM users WHERE id=? AND active=1 AND access_status=\'approved\' AND password_hash=?').get(user.id,user.password_hash);
    if (!current) throw fail(401,'E-mail ou senha invalidos.');
    if (!db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires>?').get(req.authSession.token_hash,Date.now())) throw fail(403,'Sessao encerrada. Atualize a pagina.');
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.authSession.token_hash);
    req.authSession = newSession(res,user.id); req.user=current;
    db.prepare('DELETE FROM attempts WHERE key=?').run('email:'+digest(normalized));
    res.json(sessionData(req));
  });
  app.post('/api/logout',(req,res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.authSession.token_hash);
    res.clearCookie('plantao_session',{path:'/',httpOnly:true,secure:production,sameSite:'strict'});
    res.json({ok:true});
  });
  app.use('/api/reports',requireUser);
  app.get('/api/reports',(req,res) => {
    const {start,end} = req.query;
    const offset = Number(req.query.offset || 0);
    if (!validDate(start) || !validDate(end) || start > end || (Date.parse(end)-Date.parse(start)) > 366*86400000 || !Number.isSafeInteger(offset) || offset < 0) throw fail(400,'Periodo invalido.');
    const where = 'data>=? AND data<=?' + (req.user.perfil === 'Chefia' ? '' : ' AND autor_id=?');
    const args = [start,end]; if (req.user.perfil !== 'Chefia') args.push(req.user.id);
    // Count and page share the same database snapshot.
    const result = transaction(db,() => ({
      count:db.prepare(`SELECT count(*) AS n FROM reports WHERE ${where}`).get(...args).n,
      data:db.prepare(`SELECT * FROM reports WHERE ${where} ORDER BY data,id LIMIT 500 OFFSET ?`).all(...args,offset).map(serialize),
    }));
    res.json(result);
  });
  function canWrite(user,team) { return user.perfil === 'Chefia' || teams(user.id).includes(team); }
  function save(req,res) {
    const payload = validatePayload(req.body);
    if (!canWrite(req.user,payload.equipe)) throw fail(403,'Equipe nao liberada para seu usuario.');
    const result = transaction(db,() => {
      const previous = req.params.id ? db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id) : null;
      if (req.params.id && (!previous || (req.user.perfil !== 'Chefia' && previous.autor_id !== req.user.id))) throw fail(404,'Plantao nao encontrado.');
      if (previous && !canWrite(req.user,previous.equipe)) throw fail(403,'Equipe nao liberada.');
      if (previous && (typeof req.body.updated_at !== 'string' || previous.updated_at !== req.body.updated_at)) throw fail(409,'Este plantao mudou. Reabra pelo Historico antes de salvar.');
      const stamp = new Date(Math.max(Date.now(),previous ? Date.parse(previous.updated_at)+1 : 0)).toISOString();
      const id = previous?.id || crypto.randomUUID();
      payload.assinatura={nome:req.user.nome,perfil:req.user.perfil,user_id:req.user.id,em:stamp,imagem:defaults(req.user.id)?.signature||''};
      if (previous) db.prepare('UPDATE reports SET data=?,turno=?,equipe=?,payload=?,updated_at=? WHERE id=?').run(payload.data,payload.turno,payload.equipe,JSON.stringify(payload),stamp,id);
      else db.prepare('INSERT INTO reports VALUES (?,?,?,?,?,?,?,?)').run(id,payload.data,payload.turno,payload.equipe,req.user.id,JSON.stringify(payload),stamp,stamp);
      const row = db.prepare('SELECT * FROM reports WHERE id=?').get(id);
      db.prepare('INSERT INTO audit(report_id,actor_id,operation,occurred_at,previous_data,next_data) VALUES (?,?,?,?,?,?)')
        .run(id,req.user.id,previous?'UPDATE':'INSERT',stamp,previous?JSON.stringify(serialize(previous)):null,JSON.stringify(serialize(row)));
      return {id,updated_at:stamp,assinatura:payload.assinatura};
    });
    res.status(req.params.id ? 200 : 201).json(result);
  }
  app.post('/api/reports',save);
  app.put('/api/reports/:id',save);
  app.delete('/api/reports/:id',(req,res) => {
    const result = transaction(db,() => {
      const previous = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
      if (!previous || (req.user.perfil !== 'Chefia' && previous.autor_id !== req.user.id)) throw fail(404,'Plantao nao encontrado.');
      if (!canWrite(req.user,previous.equipe)) throw fail(403,'Equipe nao liberada.');
      const stamp = new Date(Math.max(Date.now(),Date.parse(previous.updated_at)+1)).toISOString();
      db.prepare('DELETE FROM reports WHERE id=?').run(previous.id);
      db.prepare('INSERT INTO audit(report_id,actor_id,operation,occurred_at,previous_data,next_data) VALUES (?,?,?,?,?,?)')
        .run(previous.id,req.user.id,'DELETE',stamp,JSON.stringify(serialize(previous)),null);
      return {ok:true};
    });
    res.json(result);
  });
  app.get('/api/reports/:id/audit',(req,res) => {
    if (req.user.perfil !== 'Chefia') throw fail(403,'Acesso exclusivo da Chefia.');
    res.json(db.prepare('SELECT * FROM audit WHERE report_id=? ORDER BY id DESC LIMIT 500').all(req.params.id));
  });
  // Explicit public files: never serve the database, config, source tree or legacy login.
  app.get('/',(req,res) => res.sendFile(path.join(root,'index.html')));
  app.get('/index.html',(req,res) => res.sendFile(path.join(root,'index.html')));
  app.get('/app.js',(req,res) => res.sendFile(path.join(root,'app.js')));
  app.use((req,res) => res.status(404).json({error:'Recurso nao encontrado.'}));
  app.use((error,req,res,next) => {
    const duplicate = error.message?.includes('UNIQUE constraint failed: reports.');
    const status = duplicate ? 409 : (error.status && error.status >= 400 && error.status < 500 ? error.status : 500);
    if (status === 500) console.error('Falha interna:',error.code || error.name); // Never log passwords or payloads.
    res.status(status).json({error:duplicate?'Ja existe um plantao com esta data, turno e equipe. Abra pelo Historico.':status===500?'Falha interna. Tente novamente.':error.type==='entity.parse.failed'?'JSON invalido.':error.message});
  });
  app.locals.cleanup = () => {
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    db.prepare('DELETE FROM attempts WHERE expires<?').run(Date.now());
  };
  return app;
}
if (require.main === module) {
  process.umask(0o077);
  const app = createApp();
  const server = app.listen(Number(process.env.PORT || 3000),'127.0.0.1',() => console.log('Sistema iniciado em 127.0.0.1:'+(process.env.PORT || 3000)));
  const timer = setInterval(app.locals.cleanup,60000); timer.unref();
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.close(() => { clearInterval(timer); app.locals.db.close(); process.exit(0); }));
}
module.exports = { createApp, validatePayload };
