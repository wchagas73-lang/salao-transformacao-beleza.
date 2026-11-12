# Publicação na Cloudflare Pages

## Estado do projeto

O projeto possui site público, painel administrativo, API em Pages Functions, estrutura de banco D1 e validação automática pelo GitHub Actions.

**Ainda não está em produção.** Para ativar os agendamentos com armazenamento e painel, é necessário conectar o repositório à Cloudflare Pages, criar o banco D1, executar o schema e cadastrar os segredos.

## 1. Conectar o GitHub à Cloudflare Pages

1. Entre no painel da Cloudflare.
2. Acesse **Workers & Pages > Create application > Pages > Connect to Git**.
3. Autorize o GitHub e selecione `wchagas73-lang/salao-transformacao-beleza.`.
4. Escolha a branch `main` como produção.
5. Configure:
   - Framework preset: `None`
   - Build command: deixe vazio
   - Build output directory: `.`
   - Root directory: raiz do repositório
6. Conclua a criação do projeto.

A integração com Git é necessária porque o backend usa Cloudflare Pages Functions na pasta `functions/`.

## 2. Criar e preparar o banco D1

1. Na Cloudflare, abra **Storage & databases > D1 SQL Database**.
2. Crie um banco chamado `transformacao-beleza-db`.
3. Abra o banco e acesse o console SQL.
4. Copie todo o conteúdo do arquivo `database/schema.sql` no GitHub e execute no console.
5. Confirme que as tabelas foram criadas sem erros.

## 3. Conectar o D1 ao projeto Pages

1. Abra o projeto Pages criado.
2. Entre em **Settings > Bindings** (ou na seção de Functions, conforme a interface exibida).
3. Adicione um binding do tipo **D1 database**.
4. Use exatamente o nome de variável `DB`.
5. Selecione `transformacao-beleza-db` e salve.

O nome `DB` é obrigatório porque a API acessa o banco por `env.DB`.

## 4. Cadastrar os segredos

Nas configurações do projeto Pages, abra **Settings > Variables and Secrets** e adicione para o ambiente Production:

- `ADMIN_PASSWORD`: senha administrativa forte com pelo menos 12 caracteres.
- `SESSION_SECRET`: segredo aleatório com pelo menos 32 caracteres. Não reutilize a senha administrativa.

Cadastre os valores como **Secrets**, não como variáveis públicas. Não coloque esses valores no GitHub, em arquivos HTML ou em mensagens.

## 5. Publicar e testar

1. Salve as configurações.
2. Faça um novo deploy de Production para aplicar binding e segredos.
3. Abra o endereço publicado e teste o site público.
4. Acesse `/admin.html` e entre com a senha definida em `ADMIN_PASSWORD`.
5. No painel, configure dias e horários de atendimento, duração de cada serviço e intervalo entre horários.
6. Faça uma solicitação de teste pelo site e confirme que ela aparece no painel como **solicitada**, sem ser marcada automaticamente como confirmada.
7. Teste conflito de horário, bloqueio de período, alteração de status e logout.

## Regras importantes

- Solicitações novas ficam com status `requested` até a Cátia confirmar manualmente.
- Os horários sugeridos só aparecem quando expediente e duração do serviço estiverem configurados.
- A API valida conflitos no servidor. Não confie apenas no horário mostrado no navegador.
- A proprietária deve revisar as solicitações recebidas antes de confirmar com a cliente.
- Antes de divulgar amplamente, faça testes em celular e computador e revise a política de privacidade e o processo de backup do D1.

## Documentação oficial

- [Cloudflare Pages com Git](https://developers.cloudflare.com/pages/get-started/git-integration/)
- [Bindings e Secrets em Pages Functions](https://developers.cloudflare.com/pages/functions/bindings/)
- [Configuração de build do Pages](https://developers.cloudflare.com/pages/configuration/build-configuration/)
