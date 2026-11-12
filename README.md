# Transformação e Beleza Hair

Sistema de apresentação e solicitação de agendamentos para o salão Transformação e Beleza Hair, de Cátia Souza, em Juiz de Fora/MG. Projeto desenvolvido e comercializado pela **Arcany Digital**, com repositório e infraestrutura independentes dos demais clientes.

## Funcionalidades implementadas no código

- Site público responsivo com apresentação do salão e catálogo de serviços.
- Formulário para solicitar agendamento.
- API em Cloudflare Pages Functions.
- Banco preparado para Cloudflare D1.
- Painel administrativo com autenticação por senha e sessão protegida.
- Gestão de solicitações e status.
- Configuração de dias e horários de atendimento.
- Configuração da duração dos serviços e intervalo entre horários.
- Bloqueio de períodos na agenda.
- Consulta de horários sugeridos e validação de conflitos no servidor.
- Política de privacidade.
- Validação automática de código e schema pelo GitHub Actions.

## Serviços cadastrados

Mega Hair, Hidratação, Progressivas, Corte, Escova, Luzes e Relaxamento.

## Dados do salão

- Nome: Transformação e Beleza Hair
- Responsável: Cátia Souza
- WhatsApp: (32) 98888-9108
- Endereço: Av. 7 de Setembro, 865, Condomínio Edifício Solar Paraíbuna (Galeria), Juiz de Fora/MG.

## Como funciona a confirmação

Uma solicitação enviada pelo site é registrada como **solicitada**. Ela não representa uma reserva confirmada. A Cátia deverá analisar a agenda e confirmar manualmente com a cliente.

Os horários sugeridos dependem da configuração do expediente, da duração de cada serviço e do intervalo entre opções no painel administrativo.

## Estrutura do repositório

- `index.html`: site público.
- `admin.html`: painel administrativo.
- `privacidade.html`: política de privacidade.
- `functions/api/[[path]].js`: API.
- `functions/_middleware.js`: cabeçalhos de segurança para respostas das Functions.
- `_headers`: cabeçalhos de segurança para páginas estáticas.
- `database/schema.sql`: estrutura do banco D1.
- `scripts/validate.py`: verificações locais de sintaxe e schema.
- `.github/workflows/validate.yml`: validação automática no GitHub Actions.
- `DEPLOY.md`: instruções de publicação.

## Publicação

A publicação planejada utiliza GitHub + Cloudflare Pages + Cloudflare D1. O projeto ainda depende da conexão do repositório à Cloudflare, da criação do banco, do binding `DB` e dos secrets `ADMIN_PASSWORD` e `SESSION_SECRET`.

Consulte [DEPLOY.md](DEPLOY.md) para o procedimento completo.

## Segurança

- Senha administrativa e segredo de sessão devem ser cadastrados como Secrets no ambiente Cloudflare.
- Nunca incluir credenciais no código-fonte.
- O painel exige sessão válida.
- O backend valida dados e conflitos de horário.
- Solicitações permanecem pendentes até confirmação manual.
- Antes de operar com clientes reais, testar o fluxo completo e estabelecer rotina de backup e retenção de dados.
