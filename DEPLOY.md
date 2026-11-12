# Implantação Cloudflare Pages + D1

## Situação
O site público continua como demonstração com solicitação via WhatsApp. O painel e a API foram adicionados como base técnica, mas **não estarão operacionais até configurar o D1 e os segredos no Cloudflare Pages**.

## Arquivos
- `functions/api/[[path]].js`: API de solicitação, login e gestão de status.
- `admin.html`: painel administrativo.
- `database/schema.sql`: tabelas do D1.
- `wrangler.toml`: configuração inicial do binding D1. Substituir o ID de exemplo pelo ID real.

## Configuração necessária no Cloudflare
1. No Cloudflare, abrir **Workers & Pages > Create application > Pages > Connect to Git**. Autorizar GitHub e selecionar este repositório. Usar `main` como branch de produção. A integração Git é necessária porque o projeto usa Pages Functions.
2. Configurar Framework preset como `None`, Build command em branco, Build output directory como `.` e Root directory como raiz do repositório.
2. Criar banco D1 chamado `transformacao-beleza-db`.
3. Executar `database/schema.sql` no console SQL do D1.
4. Em Pages > Settings > Functions > D1 database bindings, adicionar binding `DB` apontando para o banco. O nome do binding precisa ser exatamente `DB`.
5. Em Pages > Settings > Environment variables and secrets, cadastrar os segredos `ADMIN_PASSWORD` e `SESSION_SECRET`. Use uma senha forte e um segredo aleatório longo, diferentes entre si. Aplicar em Production e Preview conforme necessário.
6. Fazer novo deploy para que o binding e os segredos entrem em vigor.

## Limitações e cuidados antes de operar

- Solicitações públicas são gravadas como `requested`, nunca confirmadas automaticamente.
- O painel permite alterar status.
- O painel agora permite configurar dias/horários de funcionamento, duração dos serviços e intervalo entre opções.
- A consulta pública de horários livres só é ativada quando há expediente e duração cadastrados para o serviço.
- O backend valida sobreposição e tenta inserir a solicitação de forma atômica para evitar dois pedidos no mesmo intervalo. Pedidos continuam com status `requested` até a proprietária confirmar.
- Ainda não há mensagens automáticas de confirmação, lembretes, cancelamento pelo cliente ou sincronização com Google Calendar.
- Antes de receber clientes reais, adicionar proteção contra abuso/rate limiting, política de privacidade, retenção e backup.
- Não compartilhar a senha administrativa com clientes nem colocá-la no código-fonte.
\n## Documentação oficial\n- Cloudflare Pages Git integration: https://developers.cloudflare.com/pages/get-started/git-integration/\n- Cloudflare Pages bindings e secrets: https://developers.cloudflare.com/pages/functions/bindings/\n- Cloudflare Pages build configuration: https://developers.cloudflare.com/pages/configuration/build-configuration/\n