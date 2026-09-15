const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { openDatabase, createUser, hashPassword, transaction, backup } = require('./database.cjs');

async function passwordPrompt() {
  if (!process.stdin.isTTY) throw new Error('Execute em um terminal interativo para informar a senha com seguranca.');
  let muted = false;
  const output = new Writable({ write(chunk,encoding,done) { if (!muted) process.stdout.write(chunk); done(); } });
  const prompt = readline.createInterface({ input:process.stdin,output,terminal:true });
  try {
    process.stdout.write('Senha (12 a 128 caracteres): '); muted=true;
    const password = await prompt.question('');
    process.stdout.write('\nConfirme a senha: ');
    const confirmation = await prompt.question('');
    if (password !== confirmation) throw new Error('As senhas nao coincidem.');
    return password;
  } finally { prompt.close(); process.stdout.write('\n'); }
}
async function main() {
  process.umask(0o077);
  const [command,...args] = process.argv.slice(2);
  const filename = process.env.DATABASE_PATH || path.join(__dirname,'../data/relatorios.sqlite');
  if (!['init','create-user','list-users','grant-team','revoke-team','reset-password','disable-user','backup'].includes(command)) {
    throw new Error('Comandos: init | create-user EMAIL NOME Chefia|Supervisor [EQUIPE...] | list-users | grant-team EMAIL EQUIPE | revoke-team EMAIL EQUIPE | reset-password EMAIL | disable-user EMAIL | backup ARQUIVO');
  }
  if (!['init','create-user'].includes(command) && !fs.existsSync(filename)) throw new Error('Banco nao encontrado. Confira DATABASE_PATH.');
  // A backup must capture the original schema before any pending migrations.
  const db = command==='backup' ? new (require('node:sqlite').DatabaseSync)(filename,{readOnly:true}) : openDatabase(filename);
  try {
    if (command === 'init') { console.log('Banco interno inicializado.'); return; }
    if (command === 'create-user') {
      const [email,nome,perfil,...teams] = args;
      await createUser(db,{email,nome,perfil,teams,password:await passwordPrompt()});
      console.log('Conta criada.'); return;
    }
    if (command === 'list-users') { console.table(db.prepare('SELECT email,nome,perfil,active,access_status FROM users ORDER BY nome').all()); return; }
    if (command === 'backup') {
      if (!args[0]) throw new Error('Informe o arquivo de destino do backup.');
      const target = path.resolve(args[0]);
      if (fs.existsSync(target)) throw new Error('O destino ja existe. Escolha um nome novo.');
      fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
      await backup(db,target); fs.chmodSync(target,0o600);
      console.log('Backup consistente criado. Armazene uma copia fora do servidor.'); return;
    }
    const user = db.prepare('SELECT * FROM users WHERE email=?').get((args[0]||'').trim().toLowerCase());
    if (!user) throw new Error('Usuario nao encontrado.');
    if (command === 'reset-password') {
      const passwordHash = await hashPassword(await passwordPrompt());
      transaction(db,() => {
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash,user.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      });
    } else if (command === 'disable-user') {
      transaction(db,() => {
        if (user.perfil === 'Chefia' && user.active && db.prepare("SELECT count(*) AS n FROM users WHERE perfil='Chefia' AND active=1").get().n <= 1) throw new Error('Crie outra Chefia antes de desativar a ultima.');
        db.prepare("UPDATE users SET active=0,access_status='blocked',security_version=security_version+1 WHERE id=?").run(user.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      });
    } else {
      const team = args[1]?.trim();
      if (!team || team.length > 120) throw new Error('Equipe invalida.');
      if (command === 'grant-team') db.prepare('INSERT OR IGNORE INTO memberships VALUES (?,?)').run(user.id,team);
      else db.prepare('DELETE FROM memberships WHERE user_id=? AND equipe=?').run(user.id,team);
    }
    console.log('Alteracao concluida.');
  } finally { db.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode=1; });
