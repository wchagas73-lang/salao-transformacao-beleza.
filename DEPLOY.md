# Implantação Cloudflare Pages + D1

## Situação
O site público continua como demonstração com solicitação via WhatsApp. O painel e a API foram adicionados como base técnica, mas **não estarão operacionais até configurar o D1 e os segredos no Cloudflare Pages**.

## Arquivos
- `functions/api/[[path]].js`: API de solicitação, login e gestão de status.
- `admin.html`: painel administrativo.
- `database/schema.sql`: tabelas do D1.
- `wrangler.toml`: configuração inicial do binding D1. Substituir o ID de exemplo pelo ID real.

## Configuração necessária no Cloudflare
1. Criar um projeto Pages conectado a este repositório, com diretório de saída `/` e sem comando de build.
2. Criar banco D1 chamado `transformacao-beleza-db`.
3. Executar `database/schema.sql` no console SQL do D1.
4. Em Pages > Settings > Functions > D1 database bindings, adicionar binding `DB` apontando para o banco. O nome do binding precisa ser exatamente `DB`.
5. Em Pages > Settings > Environment variables and secrets, cadastrar os segredos `ADMIN_PASSWORD` e `SESSION_SECRET`. Use uma senha forte e um segredo aleatório longo, diferentes entre si. Aplicar em Production e Preview conforme necessário.
6. Fazer novo deploy. O arquivo `wrangler.toml` não contém ID fictício de banco: o vínculo real é feito no painel Cloudflare.

## Limitações deliberadas da primeira versão
- Solicitações públicas são gravadas como `requested`, nunca confirmadas automaticamente.
- O painel permite alterar status.
- Ainda não existe grade de horários livres, duração dos procedimentos, bloqueio automático de sobreposição nem confirmação automática. Isso só deve ser habilitado após definir expediente, duração e intervalos com a proprietária.
- Antes de receber clientes reais, adicionar proteção contra abuso/rate limiting, política de privacidade, retenção e backup.
- Não compartilhar a senha administrativa com clientes nem colocá-la no código-fonte.
