# Sistema de Relatorios - banco interno

API Node.js/Express com SQLite no proprio servidor. Nao requer Supabase, conta em nuvem ou servico
de banco separado. O navegador acessa apenas a API, no mesmo endereco do site.

## Rodar neste computador

Instale Node.js 24 LTS (24.12 ou mais recente da linha 24):

```sh
npm ci
npm run init-db
npm run manage -- create-user chefia@empresa.com.br "Nome da Chefia" Chefia
npm start
```

Substitua nome/e-mail por dados reais. A senha e solicitada duas vezes no terminal, sem exibicao;
nao existe senha padrao. Abra **http://127.0.0.1:3000**. O modo local aceita conexoes apenas deste computador.
O banco fica em `data/relatorios.sqlite`; preserve essa pasta nas atualizacoes.

## Recursos

- Senhas derivadas por scrypt; sessoes no banco e cookie HttpOnly/SameSite, com Secure em producao.
- Sessoes de 8 horas, revogadas ao sair, desativar a conta ou redefinir a senha.
- Protecao CSRF e limites de tentativas de login persistidos no banco.
- Cadastro publico cria apenas Supervisor, com nome, e-mail, equipe e senha de 12 a 128 caracteres. Chefia e concedida apenas pela administracao via comandos locais.
- Supervisor acessa seus relatorios e escreve em equipes liberadas; Chefia acessa todos.
- Validacao na API, autoria pelo servidor, controle de versao e auditoria atomica das gravacoes.
- Historico paginado, impressao/PDF e CSV com neutralizacao de formulas.
- Nenhuma rota publica para exclusao de relatorios, banco, codigo do servidor ou credenciais.
- Backup consistente e exemplos de agendamento diario.

## Administracao

```sh
npm run manage -- create-user supervisor@empresa.com.br "Nome Completo" Supervisor "Equipe A"
npm run manage -- grant-team supervisor@empresa.com.br "Equipe B"
npm run manage -- revoke-team supervisor@empresa.com.br "Equipe B"
npm run manage -- reset-password supervisor@empresa.com.br
npm run manage -- disable-user supervisor@empresa.com.br
npm run manage -- list-users
npm run manage -- backup backups/copia-2026-09-09.sqlite
```

Remover equipe revoga escrita; desativar conta revoga todo acesso. Cada pessoa deve ter uma conta propria.
No servidor use o usuario de servico e DATABASE_PATH indicados em [DEPLOY.md](DEPLOY.md).

## Testes e publicacao

```sh
npm test
npm run build
```

Os testes usam HTTP real em loopback, SQLite isolado e respostas simuladas para a interface.
Cobrem login, autorizacao, CSRF, conflitos, expiracao, auditoria e reabertura do backup.
Nao acessam o servidor publico. `dist/` e um **pacote de servidor**, nao uma hospedagem estatica.
Veja [DEPLOY.md](DEPLOY.md) para Ubuntu/Apache. A porta externa pode continuar em 5000, com HTTPS.

SQLite atende a instalacao em um servidor com gravacoes curtas. Ha um escritor de cada vez.
Use disco local, nunca NFS/compartilhamento de rede. Para varias instancias ou alto volume concorrente,
planeje PostgreSQL e valide a carga. O modulo nativo `node:sqlite` no Node 24 ainda emite aviso de
recurso experimental; mantenha a linha LTS especificada e o lockfile.

Arquivos antigos do Supabase e o HTML `.dc.html` permanecem como historico local, sem uso ou publicacao.
`config.js` deixou de ser necessario. Nao ha importacao automatica de dados antigos; confira-os antes de descartar.

Proximas etapas: pendencias com responsavel/prazo/status, aceite, fechamento, interface administrativa e IA.
Recuperacao de senha e feita pela administracao com o comando acima; nao ha envio de e-mail automatico.
