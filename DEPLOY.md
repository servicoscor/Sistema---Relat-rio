# Implantacao em producao

## Ordem recomendada

1. Criar projeto no Supabase.
2. Trocar o e-mail `admin@plantao.local` em `supabase/schema.sql` pelo e-mail real da Chefia.
3. Executar `supabase/schema.sql` no SQL Editor do Supabase.
4. Copiar `config.example.js` para `config.js`.
5. Preencher `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
6. Publicar os arquivos no servidor `10.50.30.161`.
7. Configurar NAT/firewall para acesso externo.
8. Colocar HTTPS com dominio valido.

## Arquivos que devem ir para o servidor

- `index.html`
- `app.js`
- `config.js`
- `.nojekyll` somente se publicar em GitHub Pages

## Windows Server com IIS

1. Instalar o recurso IIS.
2. Criar um site apontando para a pasta do projeto.
3. Garantir que `index.html` esteja como documento padrao.
4. Liberar a porta `80` ou `443` no firewall.
5. Configurar certificado SSL se houver dominio.

## Linux com Nginx

Exemplo basico:

```nginx
server {
  listen 80;
  server_name seu-dominio.com.br;
  root /var/www/relatorio-plantao;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

## Observacoes

- O `config.js` nao deve ficar no Git quando tiver chave real.
- A `SUPABASE_ANON_KEY` e publica, mas as regras RLS do banco precisam estar aplicadas.
- Para acesso externo, use HTTPS antes de liberar para usuarios finais.
