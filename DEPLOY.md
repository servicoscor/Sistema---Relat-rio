# Instalacao no SRV-RELATORIOS (Ubuntu + Apache)

Agora e necessario executar o servidor Node.js; copiar apenas HTML nao basta.
Nenhuma alteracao foi aplicada automaticamente no servidor publico ou no NAT.

## Arquitetura

Usuario -> Apache com HTTPS (porta externa 5000, se mantida pela rede) -> 127.0.0.1:3000 -> SQLite local.
A porta 3000 fica apenas em loopback. Nao abra porta de banco nem encaminhe 3000 no NAT.
A rede configura certificado e HTTPS. Confirme a origem definitiva: IP/porta ou dominio com certificado valido.

## Preparar o pacote

No computador de desenvolvimento, execute `npm ci`, `npm test` e `npm run build`.
Transfira o conteudo de `dist/` para `/opt/relatorios`, preservando as subpastas.
Nao publique a raiz do repositorio, arquivos Git, dados, config.js ou o HTML legado.
Preserve dados anteriores em local privado antes de substituir a publicacao antiga.

## Instalar no Ubuntu

Instale Node.js 24 LTS (24.12 ou mais recente da linha 24) por um canal aprovado pela TI.
Confira `node --version` e `command -v node`; os exemplos usam `/usr/bin/node`.

```sh
sudo useradd --system --home /opt/relatorios --shell /usr/sbin/nologin relatorios
sudo install -d -o relatorios -g relatorios -m 700 /var/lib/relatorios
sudo install -d -o relatorios -g relatorios -m 700 /var/backups/relatorios
cd /opt/relatorios
npm ci --omit=dev
sudo install -m 600 deploy/relatorios.env.example /etc/relatorios.env
sudoedit /etc/relatorios.env
```

Use useradd somente se a conta nao existir. Mantenha codigo sob propriedade administrativa, legivel pelo
usuario relatorios; esse usuario escreve somente nos diretorios de banco e backup.
O arquivo de ambiente deve conter a origem HTTPS exata confirmada pela rede, sem barra final:

```ini
NODE_ENV=production
APP_ORIGIN=https://187.111.99.25:5000
PORT=3000
DATABASE_PATH=/var/lib/relatorios/relatorios.sqlite
```

Em producao o aplicativo exige HTTPS e verifica host/porta. O systemd le o arquivo protegido e repassa as variaveis.

## Inicializar banco e primeira Chefia

```sh
sudo -u relatorios env DATABASE_PATH=/var/lib/relatorios/relatorios.sqlite /usr/bin/node backend/manage.cjs init
sudo -u relatorios env DATABASE_PATH=/var/lib/relatorios/relatorios.sqlite /usr/bin/node backend/manage.cjs create-user chefia@empresa.com.br "Nome da Chefia" Chefia
```

Substitua nome/e-mail. O terminal solicita senha sem exibi-la (12 a 128 caracteres).
Nao coloque senha em argumentos, repositorio ou mensagens. Para Supervisor, use o perfil Supervisor e acrescente
as equipes entre aspas. Outros comandos administrativos estao no README; use o mesmo usuario e DATABASE_PATH.
Nao e necessario executar SQL do Supabase. Banco e usuarios existentes neste SQLite sao preservados.

## Servico e Apache

```sh
sudo cp deploy/relatorios.service /etc/systemd/system/relatorios.service
sudo systemctl daemon-reload
sudo systemctl enable --now relatorios
sudo systemctl status relatorios
```

Diagnostico: `sudo journalctl -u relatorios -n 50`. O aviso experimental do node:sqlite nao indica falha de inicializacao.
A rede deve integrar `deploy/apache.conf.example` **dentro do VirtualHost HTTPS existente**, com certificado valido.
Nao duplique Listen/VirtualHost na porta 5000. Habilite proxy, proxy_http, headers e ssl; valide a configuracao:

```sh
sudo a2enmod proxy proxy_http headers ssl
sudo apachectl configtest
sudo systemctl reload apache2
```

Encaminhe o site inteiro a API. `ProxyPreserveHost On` preserva host e porta publica. Defina X-Forwarded-Proto=https
somente em um VirtualHost com TLS real. Nao aplique esse cabecalho num site HTTP simples.
Remova exposicao anterior de arquivos do repositorio e Alias para dados/legados. Redirecione HTTP ao HTTPS final.

## Backup diario

```sh
sudo cp deploy/relatorios-backup.service deploy/relatorios-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now relatorios-backup.timer
sudo systemctl start relatorios-backup.service
sudo systemctl status relatorios-backup.service
sudo systemctl list-timers relatorios-backup.timer
```

Executa as 02h no fuso do servidor, em `/var/backups/relatorios`. O comando usa a API de backup do SQLite e inclui
alteracoes no WAL. Nao copie apenas o arquivo principal enquanto o banco estiver em uso.
Backups manuais: `backend/manage.cjs backup /caminho/novo.sqlite`, com usuario e DATABASE_PATH como acima.
O comando nao sobrescreve arquivos. Configure copia externa, retencao e monitoramento de disco com a TI.
O agendamento nao apaga copias antigas. As copias contem dados pessoais, hashes e sessoes; proteja o acesso.

## Recuperacao por administrador

1. Pare relatorios e relatorios-backup.timer; preserve o banco atual e seus arquivos WAL/SHM em local separado.
2. Confira uma copia do backup com `PRAGMA integrity_check;` e contagens de usuarios, relatorios e auditoria.
3. Coloque o banco restaurado em DATABASE_PATH com proprietario relatorios e permissao 600. Nao deixe WAL/SHM
   do banco anterior nesse caminho.
4. Antes de iniciar, invalide sessoes antigas executando `DELETE FROM sessions;` no banco restaurado.
5. Inicie servico/timer e valide login e abertura de relatorios. Teste o procedimento em ambiente separado periodicamente.

## Validacao e atualizacoes

- HTTPS valido em acesso interno/externo, sem tela de configuracao do Supabase.
- Login Chefia/Supervisor, criacao, edicao, PDF e CSV.
- Supervisor nao acessa outro autor nem grava em equipe nao liberada.
- Duas abas editando a mesma versao: segunda recebe conflito e preserva o texto.
- Logout revoga sessao; troca de conta limpa formulario anterior.
- URLs /data/relatorios.sqlite, /config.js e /backend/server.cjs retornam 404.
- Backup reabre e contem os dados esperados.

Atualize somente o codigo em /opt/relatorios, execute npm ci --omit=dev e reinicie na janela de manutencao.
Preserve DATABASE_PATH e backups. Esta versao nao importa automaticamente dados do antigo Supabase.

Referencias: [SQLite em servidores](https://www.sqlite.org/whentouse.html) e
[seguranca Express](https://expressjs.com/en/advanced/best-practice-security/).
