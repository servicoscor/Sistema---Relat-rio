const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {openDatabase}=require('../backend/database.cjs');
test('legacy Supervisors require one-time review; Chefia and records are preserved',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plantao-migration-'));
  const file=path.join(dir,'legacy.sqlite');let db=new DatabaseSync(file);
  try{
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE,nome TEXT,password_hash TEXT,perfil TEXT,active INTEGER);
      INSERT INTO users VALUES ('chief','chief@test.test','Chefia','hash','Chefia',1),('sup','sup@test.test','Supervisor','hash','Supervisor',1),('blocked','blocked@test.test','Bloqueado','hash','Supervisor',0);
      CREATE TABLE memberships(user_id TEXT,equipe TEXT,PRIMARY KEY(user_id,equipe));
      INSERT INTO memberships VALUES ('sup','Equipe antiga');
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,csrf TEXT,expires INTEGER);
      INSERT INTO sessions VALUES ('old','sup','csrf',9999999999999),('chiefsession','chief','csrf',9999999999999);
      CREATE TABLE reports(id TEXT PRIMARY KEY,data TEXT,turno TEXT,equipe TEXT,autor_id TEXT,payload TEXT,created_at TEXT,updated_at TEXT);
      INSERT INTO reports VALUES ('report','2026-09-15','Diurno','Equipe antiga','sup','{}','old','old');`);
    db.close();db=openDatabase(file);
    assert.equal(db.prepare("SELECT access_status FROM users WHERE id='sup'").get().access_status,'pending');
    assert.equal(db.prepare("SELECT active FROM users WHERE id='sup'").get().active,0);
    assert.equal(db.prepare("SELECT access_status FROM users WHERE id='blocked'").get().access_status,'blocked');
    assert.equal(db.prepare("SELECT active FROM users WHERE id='chief'").get().active,1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE user_id='sup'").get().n,0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE user_id='chief'").get().n,1);
    assert.equal(db.prepare("SELECT autor_id FROM reports WHERE id='report'").get().autor_id,'sup');
    assert.equal(db.prepare("SELECT equipe FROM memberships WHERE user_id='sup'").get().equipe,'Equipe antiga');
    db.exec("UPDATE users SET active=1,access_status='approved' WHERE id='sup'");
    db.close();db=openDatabase(file);
    assert.equal(db.prepare("SELECT active FROM users WHERE id='sup'").get().active,1);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true})}
});
