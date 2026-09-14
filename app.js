const MESES = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const state = {
  loading: true, error: '', authMode: 'login', authEmail: '', authPass: '', authName: '', authTeam: '',
  user: null, profile: null, view: 'form', records: [], period: 'semana', filterTurn: 'Todos',
  filterTeam: 'Todas as equipes', refDate: today(), saved: false, form: emptyForm(), editing:null,dirty:false,saving:false,authBusy:false,recordsLoading:false,recordsError:'',teams:[]
};

function today(){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const get=t=>parts.find(p=>p.type===t).value;return `${get('year')}-${get('month')}-${get('day')}`}
function emptyForm(){return{data:today(),turno:'Diurno',equipe:'',coordenador:'',integrantes:[''],faltas:[{nome:'',motivo:''}],dia:[''],proximo:[''],ocorrencias:[{hora:'',gravidade:'Baixa',texto:''}]}}
function esc(v){return String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function clean(a){return(a||[]).map(x=>String(x).trim()).filter(Boolean)}
function parseDate(iso){const[y,m,d]=String(iso||'').split('-').map(Number);return new Date(y||1970,(m||1)-1,d||1)}
function isoDate(d){return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function shortDate(iso){const[y,m,d]=String(iso||'').split('-');return d?`${d}/${m}/${String(y).slice(2)}`:'-'}
function longDate(iso){const[y,m,d]=String(iso||'').split('-');return d?`${d} de ${MESES[Number(m)-1]} de ${y}`:'Data nao informada'}
function isChief(){return state.profile?.perfil === 'Chefia'}
function setValue(path,value){if(path==='refDate' && (!/^\d{4}-\d{2}-\d{2}$/.test(value)||isoDate(parseDate(value))!==value))return;const p=path.split('.');let t=state;while(p.length>1)t=t[p.shift()];t[p[0]]=value;if(['period','refDate'].includes(path)){state.filterTeam='Todas as equipes';void loadRecords()}render()}
function setForm(path,value){state.form[path]=value;markDirty();render()}
function addList(k,v){state.form[k].push(v);markDirty();render()}
function removeList(k,i){markDirty();state.form[k]=state.form[k].filter((_,j)=>j!==i);if(!state.form[k].length)state.form[k].push(k==='ocorrencias'?{hora:'',gravidade:'Baixa',texto:''}:k==='faltas'?{nome:'',motivo:''}:'');render()}

let sessionVersion = 0;
let recordsVersion = 0;

function resetSession(){
  sessionVersion++;
  recordsVersion++;
  Object.assign(state,{user:null,profile:null,authPass:'',authEmail:'',authName:'',authTeam:'',
    records:[],form:emptyForm(),view:'form',saved:false,error:'',editing:null,dirty:false,
    saving:false,authBusy:false,recordsLoading:false,recordsError:'',teams:[],filterTurn:'Todos',
    filterTeam:'Todas as equipes',period:'semana',refDate:today()});
}

let csrfToken = '';
let expiryTimer;
let serverUnavailable = false;
const accountChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('plantao-account') : null;

async function api(path,options={}){
  const version=sessionVersion;
  let response;
  try{response=await fetch('/api'+path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken,...options.headers}})}
  catch(error){throw new Error('Nao foi possivel conectar ao servidor. Tente novamente.')}
  let data;
  try{data=await response.json()}catch(error){throw new Error('O servidor do sistema esta indisponivel.')}
  if(!response.ok){
    if(response.status===401 && path!=='/login' && version===sessionVersion){resetSession();state.loading=false;state.error='Sua sessao expirou. Entre novamente.';render()}
    throw new Error(data.error||'Nao foi possivel concluir a operacao.');
  }
  return data;
}

async function acceptSession(session){
  csrfToken=session.csrf;
  clearTimeout(expiryTimer);
  if(session.user){
    expiryTimer=setTimeout(()=>{resetSession();state.loading=false;state.error='Sua sessao expirou. Entre novamente.';render();void init()},Math.max(0,session.expires-Date.now()));
  }
  if(session.user?.id===state.user?.id && state.profile){state.profile=session.user;state.teams=session.teams;return}
  resetSession();
  if(!session.user){state.loading=false;render();return}
  state.user={id:session.user.id};state.profile=session.user;state.teams=session.teams;
  state.form.equipe=session.teams[0]||'';
  if(isChief())state.form.coordenador=session.user.nome;
  state.loading=true;
  const version=sessionVersion;
  await loadRecords();
  if(version===sessionVersion){state.loading=false;render()}
}
async function init(){
  const version=sessionVersion;
  try{
    const session=await api('/session');
    if(version!==sessionVersion)return;
    serverUnavailable=false;await acceptSession(session);
  }catch(error){if(version===sessionVersion){serverUnavailable=true;state.loading=false;state.error=error.message;render()}}
}
async function loadRecords(){
  if(!state.user || !state.profile)return;
  const session=sessionVersion,request=++recordsVersion;
  const [start,end]=windowDates().map(isoDate);
  state.recordsLoading=true;state.recordsError='';state.records=[];
  const rows=[];
  try{
    let offset=0;
    while(true){
      const {data,count}=await api(`/reports?start=${start}&end=${end}&offset=${offset}`);
      if(session!==sessionVersion || request!==recordsVersion)return;
      if(!Array.isArray(data))throw new Error('Resposta invalida');
      rows.push(...data);offset+=data.length;
      if(count!==null && count!==undefined && offset>=count)break;
      if(!data.length){if(count>offset)throw new Error('Consulta incompleta');break}
    }
    state.records=rows;
  }catch(error){
    if(session===sessionVersion && request===recordsVersion){state.records=[];state.recordsError='Nao foi possivel carregar o periodo completo. Tente novamente.'}
  }finally{
    if(session===sessionVersion && request===recordsVersion){state.recordsLoading=false;render()}
  }
}

async function loginOrSignup(){
  if(state.authBusy)return;
  state.error='';
  const email=state.authEmail.trim().toLowerCase(),password=state.authPass;
  if(!email||!password){state.error='Informe e-mail e senha.';render();return}
  state.authBusy=true;
  const version=sessionVersion;
  try{
    if(state.authMode==='access'){
      await api('/register',{method:'POST',body:JSON.stringify({email,password,nome:state.authName,equipe:state.authTeam})});
      if(version!==sessionVersion)return;
      state.authMode='login';
    }
    const session=await api('/login',{method:'POST',body:JSON.stringify({email,password})});
    if(version!==sessionVersion)return;
    await acceptSession(session);
    accountChannel?.postMessage('changed');
  }catch(error){if(version===sessionVersion)state.error=error.message}
  finally{state.authPass='';state.authBusy=false;render()}
}
async function logout(){
  if(state.dirty && !confirm('Sair e descartar as alteracoes nao salvas?'))return;
  resetSession();clearTimeout(expiryTimer);state.loading=false;render();
  try{
    await api('/logout',{method:'POST',body:'{}'});
    csrfToken='';accountChannel?.postMessage('changed');await init();
  }catch(error){state.error='Nao foi possivel encerrar a sessao. Tente sair novamente antes de compartilhar este computador.';render()}
}

function recordPayload(){
  const f=state.form;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(f.data) || isoDate(parseDate(f.data))!==f.data)throw new Error('Informe uma data valida.');
  if(!['Diurno','Noturno'].includes(f.turno))throw new Error('Informe o turno.');
  if(!f.equipe.trim())throw new Error('Informe uma equipe autorizada.');
  if(!isChief() && !state.teams.includes(f.equipe.trim()))throw new Error('Solicite a liberacao desta equipe pela Chefia.');
  const faltas=(f.faltas||[]).filter(x=>String(x.nome||'').trim());
  const ocorrencias=(f.ocorrencias||[]).filter(x=>String(x.texto||'').trim());
  if(ocorrencias.some(o=>!['Baixa','Media','Alta'].includes(o.gravidade) || (o.hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.hora))))throw new Error('Confira horario e gravidade das ocorrencias.');
  return {data:f.data,turno:f.turno,equipe:f.equipe.trim(),coordenador:f.coordenador.trim(),
    integrantes:clean(f.integrantes),faltas:faltas.map(x=>({nome:x.nome.trim(),motivo:String(x.motivo||'').trim()})),
    dia:clean(f.dia),proximo:clean(f.proximo),ocorrencias:ocorrencias.map(o=>({hora:o.hora,gravidade:o.gravidade,texto:o.texto.trim()}))};
}

async function saveRecord(){
  if(!state.user || !state.profile || state.saving)return;
  const version=sessionVersion;
  state.saving=true;state.error='';state.saved=false;
  try{
    const payload=recordPayload(),snapshot=JSON.stringify(state.form);
    const data=state.editing
      ?await api('/reports/'+encodeURIComponent(state.editing.id),{method:'PUT',body:JSON.stringify({...payload,updated_at:state.editing.updated_at})})
      :await api('/reports',{method:'POST',body:JSON.stringify(payload)});
    if(version!==sessionVersion)return;
    state.editing=data;state.dirty=JSON.stringify(state.form)!==snapshot;state.saved=!state.dirty;
    await loadRecords();
  }catch(error){if(version===sessionVersion)state.error=error.message}
  finally{if(version===sessionVersion){state.saving=false;render()}}
}

function clearForm(){
  if(state.saving)return;
  if(state.dirty && !confirm('Descartar as alteracoes nao salvas?'))return;
  state.form=emptyForm();state.form.equipe=state.teams[0]||'';
  state.editing=null;state.dirty=false;state.saved=false;state.error='';state.view='form';render();
}
function openRecord(id){
  if(state.saving)return;
  const row=state.records.find(r=>r.id===id);if(!row)return;
  if(state.dirty && !confirm('Descartar as alteracoes nao salvas e abrir este plantao?'))return;
  state.form=JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(emptyForm()).map(k=>[k,row[k]]))));
  for(const key of ['integrantes','dia','proximo'])if(!state.form[key].length)state.form[key]=[''];
  if(!state.form.faltas.length)state.form.faltas=[{nome:'',motivo:''}];
  if(!state.form.ocorrencias.length)state.form.ocorrencias=[{hora:'',gravidade:'Baixa',texto:''}];
  state.editing={id:row.id,updated_at:row.updated_at};state.dirty=false;state.saved=false;state.error='';state.view='form';render();
}
function markDirty(){state.dirty=true;state.saved=false;const button=document.getElementById('save-record');if(button && !state.saving)button.textContent='Salvar plantao'}
function csvCell(value){
  let text=String(value??'');
  if(/^[\s\uFEFF]*[=+@\-\uFF1D\uFF0B\uFF20\uFF0D]/u.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
function windowDates(){const ref=parseDate(state.refDate);if(state.period==='mes')return[new Date(ref.getFullYear(),ref.getMonth(),1),new Date(ref.getFullYear(),ref.getMonth()+1,0)];const s=new Date(ref);s.setDate(ref.getDate()-((ref.getDay()+6)%7));const e=new Date(s);e.setDate(s.getDate()+6);return[s,e]}
function periodRecords(){const[start,end]=windowDates().map(isoDate);return state.records.filter(r=>r.data>=start&&r.data<=end).filter(r=>state.filterTurn==='Todos'||r.turno===state.filterTurn).filter(r=>state.filterTeam==='Todas as equipes'||(r.equipe||'-')===state.filterTeam)}
function exportCsv(){if(!isChief()||state.recordsLoading||state.recordsError)return;const rows=periodRecords(),[start,end]=windowDates().map(isoDate),header=['data','turno','equipe','coordenador','integrantes','faltas','demandas_do_dia','proximo_plantao','ocorrencias'],cell=csvCell;const lines=rows.map(r=>[r.data,r.turno,r.equipe,r.coordenador,(r.integrantes||[]).join(' | '),(r.faltas||[]).map(f=>`${f.nome}${f.motivo?` (${f.motivo})`:''}`).join(' | '),(r.dia||[]).join(' | '),(r.proximo||[]).join(' | '),(r.ocorrencias||[]).map(o=>`${o.hora||'--'} [${o.gravidade}] ${o.texto}`).join(' | ')].map(cell).join(','));const blob=new Blob(['\ufeff'+[header.join(','),...lines].join('\n')],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`plantoes-${start}-a-${end}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

function setupView(){return `<main class="wrap"><h1>Conectar ao servidor</h1><p>${esc(state.error||'O servidor do sistema nao respondeu.')}</p><button onclick="init()">Tentar novamente</button></main>`}
function loginArtwork(){return `<svg class="login-art" viewBox="0 0 714 854" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><radialGradient id="redGlow"><stop stop-color="#c30b00"/><stop offset="1" stop-color="#360300"/></radialGradient><pattern id="redDots" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".8" fill="#ee2917" opacity=".55"/></pattern><linearGradient id="redBar" x2="0" y2="1"><stop stop-color="#d70a10"/><stop offset="1" stop-color="#700300"/></linearGradient></defs><path fill="url(#redGlow)" d="M0 0h714v854H0z"/><path fill="url(#redDots)" d="M478 0h236v120H478zM236 510h478v300H236z"/><circle cx="500" cy="228" r="151" fill="none" stroke="#bd160b" opacity=".6"/><g fill="#430400" fill-opacity=".65" stroke="#ae160b"><rect x="432" y="127" width="281" height="164" rx="14"/><rect x="478" y="306" width="230" height="149" rx="13"/><rect x="470" y="470" width="238" height="99" rx="12"/></g><circle cx="514" cy="211" r="46" fill="none" stroke="#ad0000" stroke-width="24"/><circle cx="514" cy="211" r="46" fill="none" stroke="#e11018" stroke-width="24" stroke-dasharray="143 290" transform="rotate(-90 514 211)"/><g stroke="#b70b10" stroke-width="4" stroke-linecap="round">${[176,199,222,245].map(y=>`<path d="M614 ${y}h71"/><circle cx="597" cy="${y}" r="2"/>`).join('')}</g><g stroke="#8b0a06" opacity=".55">${[330,356,382,408,436].map(y=>`<path d="M498 ${y}h193"/>`).join('')}</g><path d="M498 425C518 412 515 393 539 400S558 367 583 381S611 378 630 356S654 374 668 344L686 330" fill="none" stroke="#f3212b" stroke-width="2"/><circle cx="686" cy="330" r="5" fill="#ed202b"/><g fill="#eee" font-family="Arial"><text x="484" y="496" font-size="6">TOTAL DE RELATÓRIOS</text><text x="562" y="496" font-size="6">PENDÊNCIAS</text><text x="635" y="496" font-size="6">CONCLUÍDOS</text><text x="484" y="522" font-size="18">1.248</text><text x="562" y="522" font-size="18">86</text><text x="635" y="522" font-size="18">93%</text></g><g fill="#c60910">${Array.from({length:30},(_,i)=>`<rect x="${484+Math.floor(i/10)*76+(i%10)*5.5}" y="${540-i%4}" width="3" height="${10+i%4}"/>`).join('')}</g><g fill="url(#redBar)">${[55,80,98,118,131,158,126,157].map((h,i)=>`<rect x="${384+i*42}" y="${778-h}" width="22" height="${h}"/>`).join('')}</g><path d="M350 778h357" stroke="#c62820"/></svg>`}
function authView(){const access=state.authMode==='access';return `<main class="login"><section class="login-visual" aria-label="Sistema de Relatórios">${loginArtwork()}<p class="login-eyebrow">Painel analítico</p><div class="login-title"><h1>Sistema de<br>Relatórios</h1><p class="login-description">Centralize indicadores, acompanhe<br class="desktop-break"> pendências e consolide informações<br class="desktop-break"> com clareza e agilidade.</p></div><p class="login-footer">Acesso corporativo · Relatórios · Indicadores</p></section><section class="login-panel"><div class="login-card"><div class="login-tabs"><button type="button" aria-pressed="${!access}" class="${!access?'selected':''}" onclick="state.authMode='login';render()">Entrar</button><button type="button" aria-pressed="${access}" class="${access?'selected':''}" onclick="state.authMode='access';render()">Criar conta</button></div><h2>${access?'Criar conta':'Entrar no sistema'}</h2><p class="login-intro">${access?'Cadastre-se como Supervisor para registrar seu plantão.':'Use o e-mail cadastrado pela chefia do seu plantão.'}</p><form onsubmit="event.preventDefault();loginOrSignup()"><div class="field"><label for="login-email">E-mail funcional</label><input id="login-email" placeholder="nome@orgao.gov.br" type="email" autocomplete="username" required value="${esc(state.authEmail)}" oninput="state.authEmail=this.value"></div>${access?`<div class="field"><label for="register-name">Nome completo</label><input id="register-name" autocomplete="name" required maxlength="200" value="${esc(state.authName)}" oninput="state.authName=this.value"></div><div class="field"><label for="register-team">Equipe / plantão</label><input id="register-team" placeholder="Ex.: Equipe B" required maxlength="120" value="${esc(state.authTeam)}" oninput="state.authTeam=this.value"></div><p class="login-intro">Perfil Supervisor: acesso apenas aos seus relatórios. O consolidado geral é exclusivo da Chefia.</p>`:''}<div class="field"><label for="login-password">Senha</label><input id="login-password" placeholder="${access?'Mínimo 12 caracteres':'Digite sua senha'}" type="password" autocomplete="current-password" required ${access?'minlength="12"':''} maxlength="128" oninput="state.authPass=this.value"></div>${state.error?`<p class="error" role="alert">${esc(state.error)}</p>`:''}<div class="login-actions"><button class="primary" ${state.authBusy?'disabled':''} type="submit">${state.authBusy?'Aguarde...':access?'Criar conta':'Entrar'}</button><button class="login-link" type="button" onclick="state.authMode='${access?'login':'access'}';state.error='';render()">${access?'Já tenho conta':'Não tenho conta'}</button></div></form>${state.error.includes('encerrar a sessao')?'<button onclick="logout()">Tentar sair novamente</button>':''}</div></section></main>`}
function topbar(){return`<nav class="topbar no-print"><div class="brand">Relatorio de Plantao</div><div class="userbox"><strong>${esc(state.profile.nome)}</strong>${esc(state.profile.perfil)}${state.profile.equipe?' - '+esc(state.profile.equipe):''}</div><button onclick="clearForm()">Limpar</button><button onclick="state.view='consolidado';render();void loadRecords()">${isChief()?'Consolidado':'Historico'}</button><button onclick="logout()">Sair</button><button id="save-record" class="secondary" ${state.saving?'disabled':''} onclick="saveRecord()">${state.saving?'Salvando...':state.saved?'Plantao salvo':'Salvar plantao'}</button><button class="secondary" onclick="if(state.view!=='consolidado')state.view='report';render();setTimeout(print,120)">Imprimir / PDF</button><button class="primary" onclick="state.view=state.view==='form'?'report':'form';render()">${state.view==='form'?'Gerar relatorio':'Voltar a edicao'}</button></nav>${state.error?`<p class="error no-print" role="alert">${esc(state.error)}</p>`:''}`}
function listRows(k,p){return state.form[k].map((v,i)=>`<div class="row"><textarea rows="2" placeholder="${p}" oninput="state.form.${k}[${i}]=this.value">${esc(v)}</textarea><button class="danger" onclick="removeList('${k}',${i})">Remover</button></div>`).join('')}
function formView(){const f=state.form;return`${topbar()}<main class="wrap"><section class="section grid2"><div><div class="kicker">01 - Identificacao</div><div class="field"><label>Data do plantao</label><input type="date" value="${esc(f.data)}" onchange="setForm('data',this.value)"></div><div class="field"><label>Turno</label><div class="seg"><label><input type="radio" name="turno" ${f.turno==='Diurno'?'checked':''} onchange="setForm('turno','Diurno')">Diurno</label><label><input type="radio" name="turno" ${f.turno==='Noturno'?'checked':''} onchange="setForm('turno','Noturno')">Noturno</label></div></div><div class="field"><label>Equipe</label>${isChief()?`<input maxlength="120" value="${esc(f.equipe)}" oninput="state.form.equipe=this.value">`:`<select onchange="setForm('equipe',this.value)"><option value="">Selecione uma equipe liberada</option>${state.teams.map(t=>`<option value="${esc(t)}" ${f.equipe===t?'selected':''}>${esc(t)}</option>`).join('')}</select>${!state.teams.length?'<p class="hint">Aguarde a liberacao da sua equipe pela Chefia.</p>':''}`}</div><div class="field"><label>Coordenador responsavel</label><input value="${esc(f.coordenador)}" oninput="state.form.coordenador=this.value"></div></div><div><div class="kicker">02 - Integrantes e faltas</div>${(f.integrantes||[]).map((n,i)=>`<div class="row"><input value="${esc(n)}" placeholder="Nome do integrante" oninput="state.form.integrantes[${i}]=this.value"><button class="danger" onclick="removeList('integrantes',${i})">Remover</button></div>`).join('')}<button class="secondary" onclick="addList('integrantes','')">+ Integrante</button><div class="kicker" style="margin-top:24px">Faltas</div>${(f.faltas||[]).map((x,i)=>`<div class="row"><input placeholder="Nome" value="${esc(x.nome)}" oninput="state.form.faltas[${i}].nome=this.value"><input placeholder="Justificativa" value="${esc(x.motivo)}" oninput="state.form.faltas[${i}].motivo=this.value"><button class="danger" onclick="removeList('faltas',${i})">Remover</button></div>`).join('')}<button class="secondary" onclick="addList('faltas',{nome:'',motivo:''})">+ Falta</button></div></section><section class="section grid2"><div><div class="kicker">03 - Demandas do dia</div>${listRows('dia','Descreva a demanda executada')}<button class="secondary" onclick="addList('dia','')">+ Demanda</button></div><div><div class="kicker">04 - Proximo plantao</div>${listRows('proximo','Descreva a pendencia ou repasse')}<button class="secondary" onclick="addList('proximo','')">+ Pendencia</button></div></section><section class="section"><div class="kicker">05 - Ocorrencias</div>${(f.ocorrencias||[]).map((o,i)=>`<div class="row"><input type="time" value="${esc(o.hora)}" onchange="state.form.ocorrencias[${i}].hora=this.value"><select onchange="state.form.ocorrencias[${i}].gravidade=this.value"><option ${o.gravidade==='Baixa'?'selected':''}>Baixa</option><option ${o.gravidade==='Media'?'selected':''}>Media</option><option ${o.gravidade==='Alta'?'selected':''}>Alta</option></select><textarea placeholder="Descricao da ocorrencia e providencias" oninput="state.form.ocorrencias[${i}].texto=this.value">${esc(o.texto)}</textarea><button class="danger" onclick="removeList('ocorrencias',${i})">Remover</button></div>`).join('')}<button class="secondary" onclick="addList('ocorrencias',{hora:'',gravidade:'Baixa',texto:''})">+ Ocorrencia</button></section></main>`}
function occTable(rows){return rows.length?`<table><thead><tr><th>Hora</th><th>Gravidade</th><th>Registro</th></tr></thead><tbody>${rows.map(o=>`<tr><td>${esc(o.hora||'-')}</td><td>${esc(o.gravidade)}</td><td>${esc(o.texto)}</td></tr>`).join('')}</tbody></table>`:'<p class="hint">Nenhuma ocorrencia registrada neste plantao.</p>'}
function reportView(){const f=state.form,integrantes=clean(f.integrantes),faltas=(f.faltas||[]).filter(x=>String(x.nome||'').trim()),dia=clean(f.dia),proximo=clean(f.proximo),ocs=(f.ocorrencias||[]).filter(o=>String(o.texto||'').trim());return`${topbar()}<main class="report"><div class="kicker">Relatorio de plantao</div><h1>Plantao ${esc(f.turno.toLowerCase())} - ${esc(longDate(f.data))}</h1><div class="grid3 section"><div><label>Equipe</label>${esc(f.equipe||'-')}</div><div><label>Coordenador responsavel</label>${esc(f.coordenador||'-')}</div><div><label>Ocorrencias</label>${String(ocs.length).padStart(2,'0')}</div></div><section class="section"><h3>Integrantes</h3>${integrantes.length?integrantes.map(x=>`<span class="tag">${esc(x)}</span>`).join(''):'<p class="hint">Nenhum integrante informado.</p>'}<h3 style="margin-top:22px">Faltas - ${String(faltas.length).padStart(2,'0')}</h3>${faltas.length?faltas.map(x=>`<p><strong>${esc(x.nome)}</strong> - ${esc(x.motivo||'Sem justificativa')}</p>`).join(''):'<p class="hint">Nenhuma falta registrada.</p>'}</section><section class="section grid2"><div><h3>Demandas do dia</h3>${dia.length?dia.map((x,i)=>`<p><strong>${String(i+1).padStart(2,'0')}</strong> ${esc(x)}</p>`).join(''):'<p class="hint">Sem demandas registradas.</p>'}</div><div><h3>Para o proximo plantao</h3>${proximo.length?proximo.map((x,i)=>`<p><strong>${String(i+1).padStart(2,'0')}</strong> ${esc(x)}</p>`).join(''):'<p class="hint">Sem pendencias registradas.</p>'}</div></section><section class="section"><h3>Ocorrencias</h3>${occTable(ocs)}</section><section class="section grid2" style="margin-top:40px"><div><label>Coordenador responsavel</label><br><br>________________________________</div><div><label>Recebido pelo plantao seguinte</label><br><br>________________________________</div></section></main>`}
function consolidatedView(){if(state.recordsLoading||state.recordsError)return `${topbar()}<main class="wrap"><p>${esc(state.recordsError||'Carregando o periodo completo...')}</p><button onclick="void loadRecords()">Atualizar</button></main>`;const rows=periodRecords(),[start,end]=windowDates().map(isoDate),teams=Array.from(new Set(state.records.map(r=>r.equipe).filter(Boolean))).sort(),ocs=rows.flatMap(r=>(r.ocorrencias||[]).map(o=>({...o,data:r.data,turno:r.turno,equipe:r.equipe}))),faltas=rows.flatMap(r=>(r.faltas||[]).map(f=>({...f,data:r.data}))),pend=rows.flatMap(r=>(r.proximo||[]).map(p=>({texto:p,data:r.data,turno:r.turno,equipe:r.equipe})));return`${topbar()}<main class="wrap"><section class="section"><div class="kicker">Relatorio consolidado</div><h1>${state.period==='mes'?`${MESES[parseDate(state.refDate).getMonth()]} de ${parseDate(state.refDate).getFullYear()}`:'Semana operacional'}</h1><p class="hint">${shortDate(start)} a ${shortDate(end)} - ${state.filterTurn.toLowerCase()} - ${state.filterTeam.toLowerCase()}</p><div class="no-print row"><div class="seg"><label><input type="radio" name="period" ${state.period==='semana'?'checked':''} onchange="setValue('period','semana')">Semanal</label><label><input type="radio" name="period" ${state.period==='mes'?'checked':''} onchange="setValue('period','mes')">Mensal</label></div><select onchange="setValue('filterTurn',this.value)"><option>Todos</option><option ${state.filterTurn==='Diurno'?'selected':''}>Diurno</option><option ${state.filterTurn==='Noturno'?'selected':''}>Noturno</option></select><select onchange="setValue('filterTeam',this.value)"><option>Todas as equipes</option>${teams.map(t=>`<option ${state.filterTeam===t?'selected':''}>${esc(t)}</option>`).join('')}</select><input type="date" value="${esc(state.refDate)}" onchange="setValue('refDate',this.value)"></div></section><section class="grid5"><div class="metric"><strong>${String(rows.length).padStart(2,'0')}</strong><span>Plantoes</span></div><div class="metric"><strong>${String(rows.filter(r=>r.turno==='Diurno').length).padStart(2,'0')}</strong><span>Diurnos</span></div><div class="metric"><strong>${String(rows.filter(r=>r.turno==='Noturno').length).padStart(2,'0')}</strong><span>Noturnos</span></div><div class="metric"><strong>${String(ocs.length).padStart(2,'0')}</strong><span>Ocorrencias</span></div><div class="metric"><strong>${String(faltas.length).padStart(2,'0')}</strong><span>Faltas</span></div></section><section class="section"><h3>Plantoes salvos</h3>${rows.length?`<table><thead><tr><th>Data</th><th>Turno</th><th>Equipe</th><th>Coordenador</th><th>Demandas</th><th>Pendencias</th><th>Ocorrencias</th><th>Faltas</th><th class="no-print">Acao</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${shortDate(r.data)}</td><td>${esc(r.turno)}</td><td>${esc(r.equipe||'-')}</td><td>${esc(r.coordenador||'-')}</td><td>${(r.dia||[]).length}</td><td>${(r.proximo||[]).length}</td><td>${(r.ocorrencias||[]).length}</td><td>${(r.faltas||[]).length}</td><td class="no-print"><button data-open-record="${esc(r.id)}">Abrir</button></td></tr>`).join('')}</tbody></table>`:'<p class="hint">Nenhum plantao salvo neste periodo.</p>'}</section><section class="section grid2"><div><h3>Ocorrencias do periodo</h3>${ocs.length?ocs.map(o=>`<p><strong>${shortDate(o.data)} - ${esc(o.turno)} - ${esc(o.hora||'sem hora')}</strong><br>${esc(o.texto)}</p>`).join(''):'<p class="hint">Sem ocorrencias no periodo.</p>'}</div><div><h3>Repasses registrados no periodo</h3>${pend.length?pend.map(p=>`<p><strong>${shortDate(p.data)} - ${esc(p.turno)} - ${esc(p.equipe||'-')}</strong><br>${esc(p.texto)}</p>`).join(''):'<p class="hint">Sem pendencias no periodo.</p>'}</div></section><section class="section"><h3>Faltas do periodo</h3>${faltas.length?`<table><thead><tr><th>Data</th><th>Nome</th><th>Justificativa</th></tr></thead><tbody>${faltas.map(f=>`<tr><td>${shortDate(f.data)}</td><td>${esc(f.nome)}</td><td>${esc(f.motivo||'Sem justificativa')}</td></tr>`).join('')}</tbody></table>`:'<p class="hint">Nenhuma falta no periodo.</p>'}<div class="no-print" style="margin-top:24px">${isChief()?`<button class="secondary" ${state.recordsLoading||state.recordsError?'disabled':''} onclick="exportCsv()">Exportar CSV</button>`:''}</div></section></main>`}
function render(){const app=document.getElementById('app');if(state.loading)app.innerHTML='<main class="wrap"><p>Carregando...</p></main>';else if(serverUnavailable)app.innerHTML=setupView();else if(!state.user)app.innerHTML=authView();else if(!state.profile)app.innerHTML=`<main class="wrap"><p>${esc(state.error||'Acesso indisponivel.')}</p><button onclick="logout()">Sair</button></main>`;else if(state.view==='report')app.innerHTML=reportView();else if(state.view==='consolidado')app.innerHTML=consolidatedView();else app.innerHTML=formView()}
document.addEventListener('input',event=>{if(state.user && event.target.matches('.wrap input,.wrap textarea,.wrap select') && state.view==='form')markDirty()});
document.addEventListener('change',event=>{if(state.user && event.target.matches('.wrap input,.wrap textarea,.wrap select') && state.view==='form')markDirty()});
document.addEventListener('click',event=>{const button=event.target.closest('[data-open-record]');if(button)openRecord(button.dataset.openRecord)});
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue=''}});
if(accountChannel)accountChannel.onmessage=()=>{resetSession();state.loading=true;render();void init()};
window.addEventListener('focus',()=>{if(!state.authBusy)void init()});
init();

