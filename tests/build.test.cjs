const test=require('node:test');
const assert=require('node:assert/strict');
const {files}=require('../scripts/build.cjs');
test('server bundle contains backend and excludes databases, credentials and legacy pages',()=>{
  assert.ok(files.includes('backend/server.cjs'));assert.ok(files.includes('backend/manage.cjs'));assert.ok(files.includes('package-lock.json'));
  assert.ok(files.every(file=>!file.includes('config.js')&&!file.includes('supabase')&&!file.endsWith('.sqlite')&&!file.endsWith('.dc.html')&&!file.startsWith('data/')));
});
