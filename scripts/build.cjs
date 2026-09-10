const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const output = path.join(root, 'dist');
const files = ['index.html','app.js','package.json','package-lock.json','README.md','DEPLOY.md',
  'backend/database.cjs','backend/server.cjs','backend/manage.cjs',
  'deploy/relatorios.service','deploy/apache.conf.example','deploy/relatorios.env.example',
  'deploy/relatorios-backup.service','deploy/relatorios-backup.timer'];
function build(){
  for(const file of files)if(!fs.existsSync(path.join(root,file)))throw new Error('Arquivo ausente: '+file);
  fs.mkdirSync(output,{recursive:true});
  const allowed = new Set([...files,...files.filter(f=>f.includes('/')).map(f=>f.split('/')[0])]);
  function inspect(folder,prefix=''){
    for(const item of fs.readdirSync(folder,{withFileTypes:true})){
      const relative=prefix+item.name;
      if(item.isSymbolicLink()||!allowed.has(relative))throw new Error('dist contem arquivos antigos ou nao autorizados. Revise a pasta antes de publicar.');
      if(item.isDirectory())inspect(path.join(folder,item.name),relative+'/');
    }
  }
  inspect(output);
  for(const file of files){fs.mkdirSync(path.dirname(path.join(output,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(output,file));}
  console.log('Pacote de servidor criado em dist/. Banco, contas e configuracoes privadas nao incluidos.');
}
if(require.main===module)build();
module.exports={files,build};
