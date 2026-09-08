# Sistema Relatorio de Plantao

Aplicacao web estatica para registro, impressao e consolidacao de relatorios de plantao.

## Funcionalidades

- Cadastro e login local.
- Acesso geral com perfil de Chefia.
- Registro de data, turno, equipe e coordenador.
- Controle de integrantes e faltas.
- Registro de demandas do dia, pendencias para o proximo plantao e ocorrencias.
- Geracao de relatorio para impressao ou PDF.
- Historico local de plantoes salvos.
- Painel consolidado semanal ou mensal para perfil de Chefia.
- Exportacao CSV do consolidado.

## Configuracao do Supabase

1. Crie um projeto no Supabase.
2. Abra `SQL Editor` e execute o arquivo `supabase/schema.sql`.
3. Copie `config.example.js` para `config.js`.
4. Preencha `SUPABASE_URL` e `SUPABASE_ANON_KEY` em `config.js`.
5. Em `Authentication > Providers > Email`, defina se o projeto exigira confirmacao por e-mail.

## Acesso geral

O acesso geral e definido pela tabela `app_admin_emails` no Supabase. O SQL inicial usa:

- E-mail: `admin@plantao.local`
- Perfil: `Chefia`

Antes de executar em producao, troque esse e-mail no arquivo `supabase/schema.sql` pelo seu e-mail real. Depois cadastre esse mesmo e-mail na tela do sistema. O banco criara o perfil como `Chefia`; os demais usuarios entram como `Supervisor`.

## Publicacao

Este projeto esta pronto para hospedagem estatica. O arquivo principal e `index.html`.

Para publicar pelo GitHub Pages:

1. Envie os arquivos para o branch `main`.
2. No GitHub, acesse `Settings > Pages`.
3. Em `Build and deployment`, selecione `Deploy from a branch`.
4. Escolha o branch `main` e a pasta `/root`.
5. Salve e aguarde a URL de publicacao.

## Observacao importante

A senha nao fica salva no navegador. O login e controlado pelo Supabase Auth e os relatorios ficam centralizados no banco. A chave `SUPABASE_ANON_KEY` e publica por natureza, mas as permissoes do banco dependem das politicas RLS do arquivo `supabase/schema.sql`.
