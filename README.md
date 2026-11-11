# Transformação e Beleza Hair

Projeto de cliente desenvolvido pela **Arcany Digital**.

Site de apresentação e solicitação de agendamento para o salão de Cátia Souza, em Juiz de Fora/MG.

## Estrutura atual

- `index.html`: primeira versão demonstrativa responsiva.
- `database/schema.sql`: estrutura inicial preparada para Cloudflare D1, ainda não conectada ao site.

## Demonstração atual

A pessoa seleciona serviço, data e horário desejados e envia uma solicitação pré-preenchida ao WhatsApp do salão. **O envio não confirma reserva nem consulta disponibilidade real.**

## Próximas etapas

1. Confirmar com a proprietária horários de funcionamento, duração de cada serviço, intervalos e regras de cancelamento/remarcação.
2. Criar backend com Cloudflare Workers e conectar o banco D1.
3. Implementar validação de conflitos de horários no servidor para impedir reservas simultâneas.
4. Criar painel administrativo protegido para a proprietária.
5. Publicar pelo Cloudflare Pages e testar em celular e computador.

## Dados do salão

- Nome: Transformação e Beleza Hair
- Responsável: Cátia Souza
- WhatsApp: (32) 98888-9108
- Endereço: Av. 7 de Setembro, 865, Condomínio Edifício Solar Paraíbuna (Galeria), Juiz de Fora/MG

## Segurança e privacidade

Não armazenar senhas em texto puro. O painel deverá usar autenticação segura. Coletar apenas os dados necessários para agendamento e definir política de retenção antes de operar com clientes reais.

## Painel administrativo

Após a implantação e configuração do D1 e dos segredos, o painel ficará em `/admin.html`. A API utiliza sessão em cookie HttpOnly e senha armazenada somente como segredo no ambiente Cloudflare.

## Importante antes de uso real

O formulário público só registra solicitações como pendentes. Ele não garante vaga, não calcula duração e não bloqueia horários. A proprietária deve confirmar cada solicitação. A implementação de disponibilidade automática exige definir expediente, duração e intervalos de cada serviço.
