# Serviço de contas em VPS própria

O alvo `vps` executa as mesmas rotas do serviço de contas em Bun, sem Workers,
D1 ou R2 remotos. O código dos adaptadores fica em `apps/auth-api/src/vps/`.
O alvo Cloudflare continua disponível para instalações existentes.

O diretório persistente contém `accounts.sqlite` (contas, sessões, convites e
membros), `objects.sqlite` (avatares, skills e sites) e `identity.secret.json`
(chave de assinatura e segredo do webhook do Signal). As 52 migrations existentes
são aplicadas em ordem, com checksum, transação por arquivo e registro de aplicação.
Reabrir o serviço preserva dados e identidade. Se o banco existir e a identidade
estiver ausente, a inicialização falha em vez de gerar outra chave.

Conversas, anexos, agentes, configurações do aplicativo e chaves privadas dos hosts
continuam no computador que executa o OpenBot. Não copie esse perfil para a API.

## Compilar e verificar

Na raiz, com as dependências do lockfile instaladas:

```bash
bun run --cwd apps/auth-api build:vps
bun run --cwd apps/auth-api test:vps
bun scripts/account-service-endpoints-e2e.ts
bun apps/auth-api/scripts/vps-account-e2e.ts --browser
```

No Mac de desenvolvimento, executar os comandos pelo launcher `codex-heavy`, um
por vez. O navegador opcional exige Chrome instalado e usa um perfil temporário.
Os relatórios ficam em `.openbot-build/vps-*-e2e/`. O build fica em
`apps/auth-api/dist-vps/`; não deve ser servido inteiro como pasta pública.
Somente `dist-vps/client` contém os arquivos estáticos públicos.

## Convites por e-mail

O aplicativo e o serviço VPS aceitam convites por e-mail no domínio HTTPS próprio.
O servidor deriva a origem dos links exclusivamente de `OPENBOT_AUTH_PUBLIC_ORIGIN`;
cabeçalhos `Host` e URLs enviadas pelo cliente não configuram essa confiança.
O SMTP configurado para login também entrega os convites. Atualize cliente e API
para essa versão antes de usar o envio; apenas atualizar o servidor não remove o
bloqueio dos aplicativos antigos.

O convite abre `/join` na própria origem e oferece abertura no aplicativo ou
continuação em `/app`. Quem recebe deve usar o mesmo serviço de contas. Links
anteriores `openbot://join` continuam aceitos. O envio exige proprietário ou admin,
um convite individual aberto e o mesmo destinatário e papel registrados no banco.
Convites permanentes continuam compartilhados por link. Revogação, expiração,
limites de envio e revogação após falha SMTP permanecem em vigor.

O E2E focado executa as rotas atuais diretamente por HTTP local, SQLite temporário
e SMTP/TLS de teste, sem build nem e-mails externos:

```bash
codex-heavy -- bun --conditions=browser apps/auth-api/scripts/vps-invite-email-e2e.ts
```

O relatório fica em `.openbot-build/vps-invite-email-e2e/report.json` e integra
`test:vps`. Para conferir também o navegador na versão de desenvolvimento, inicie
a API de desenvolvimento sem credenciais reais e informe sua origem local em
`INVITE_E2E_VITE_ORIGIN`. O script usa Chrome com perfil novo, um fluxo por vez,
e direciona a origem HTTPS fictícia somente aos serviços locais.

## Configuração de produção

Quando persistidas no checkout, manter configurações compartilhadas somente no
arquivo criptografado existente `apps/auth-api/.env.production`. Não criar outro arquivo `.env` ou um par de chaves
Dotenvx. O gerenciador do serviço fornece `DOTENV_PRIVATE_KEY_PRODUCTION` de forma
protegida; nunca colocar seu valor no código, nos comandos de exemplo ou nos logs.
Sem essa chave, injetar as variáveis diretamente pelo gerenciador da VPS; o runtime
independente não exige descriptografar as configurações upstream. Não inventar outra
chave para contornar a ausência da original. Variáveis necessárias:

| Variável | Uso |
| --- | --- |
| `OPENBOT_AUTH_PUBLIC_ORIGIN` | Origem HTTPS do serviço de contas, sem caminho. |
| `OPENBOT_AUTH_STATE_DIRECTORY` | Diretório persistente, exclusivo e gravável pelo serviço. |
| `OPENBOT_API_HOST` / `OPENBOT_API_PORT` | Endereço local do processo, padrão `127.0.0.1:3100`. |
| `OPENBOT_AUTH_TRUSTED_PROXY_IPS` | IPs exatos dos proxies autorizados, separados por vírgula. |
| `REMOTE_SIGNAL_URL` | URL WSS do nosso Signal, com caminho `/v1/signal`. |
| `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT` | Servidor de e-mail com TLS implícito; porta `465`. |
| `EMAIL_SMTP_USERNAME`, `EMAIL_SMTP_PASSWORD`, `EMAIL_FROM` | Credenciais da caixa de envio e remetente autorizado. |

`AUTH_EXPOSE_DEVELOPMENT_CODE` deve ficar desativada em produção. Valores `true`,
`1`, `yes` e `on` só funcionam em execução de desenvolvimento vinculada a loopback
e com origem de loopback. Não exponha o modo de teste pela Internet.
O processo de produção recusa SMTP ausente ou porta diferente de 465 antes de criar
os bancos. A autenticação e a entrega externa da caixa precisam de verificação real.

Usar Bun 1.4.2, versão fixada pelo projeto. O arquivo
`apps/auth-api/vps/openbot-accounts.service` é um modelo para instalação em
`/opt/openbot`, com dados em `/var/lib/openbot-accounts`. Ajustar os caminhos do Bun
conforme a instalação e fornecer as variáveis pelo gerenciador; não instalar esse
modelo sem configurar origem, Signal e SMTP. O serviço usa usuário dinâmico,
diretório de estado restrito e fonte somente leitura. O modelo ainda precisa de
validação na VPS escolhida.

O proxy da VPS termina HTTPS e encaminha para a porta local; deve substituir
`X-Forwarded-For` pelo endereço real do cliente. A API só usa o último endereço
encaminhado quando a conexão veio de um proxy explicitamente confiável. A API
sobrescreve cabeçalhos de IP enviados diretamente pelo cliente.

## Configuração dos endpoints no aplicativo desktop

Para iniciar pelo Dock sem variáveis de shell, o aplicativo lê
`account-service-endpoints.json` dentro do `userData` ativo. O arquivo contém
somente endpoints públicos, não credenciais:

```json
{
  "version": 1,
  "authApiOrigin": "https://<origem-da-api>",
  "signalUrl": "wss://<origem-do-signal>/v1/signal"
}
```

`authApiOrigin` deve ser HTTPS; `signalUrl` deve usar WSS e o caminho
`/v1/signal`. HTTP ou WS são aceitos somente em loopback para desenvolvimento.
O arquivo deve ser instalado pelo operador antes de abrir o aplicativo e ter
permissão restrita ao usuário (`0600`). A leitura acontece no início do processo;
reinicie o aplicativo após alterá-lo. `OPENBOT_AUTH_API_URL` e
`OPENBOT_REMOTE_SIGNAL_URL`, quando definidos no ambiente, prevalecem
individualmente. Sem arquivo nem variáveis, o aplicativo empacotado desta distribuição
usa `https://openbot.harpia.digital` e `wss://openbot.harpia.digital/v1/signal`.
O ambiente de desenvolvimento mantém seus padrões gerados. O aplicativo não escreve
o arquivo do operador ao aplicar esses padrões.

Essa configuração escolhe apenas os serviços de conta e Signal. Ela não transfere
a sessão salva no `userData`, a identidade UUID da conta, os dados da VPS nem os
dados locais do host. Antes do corte, preserve o perfil e faça a migração de
identidade e reconciliação descritas abaixo; não aponte o perfil ativo para uma
conta vazia.

## Signal e TURN sem Cloudflare

O Signal em `remote/api/` permanece necessário para presença, conexões e eventos de
conta; o coturn oferece relay quando a conexão direta não funciona. Ambos podem
rodar na mesma VPS com domínios próprios e certificados administrados nela.
O compose atual de `remote/` usa DNS Cloudflare para emitir certificados: ele **não
é a receita de publicação desta alternativa**. Na implantação, usar o proxy e a
emissão de certificados da VPS escolhida, com certificado também disponível ao
coturn; conferir portas TCP/UDP e faixa de relay antes da troca.

Configurar `REMOTE_TICKET_JWKS_URL` do Signal para a nossa API em
`/.well-known/jwks.json`, `REMOTE_CONTROL_PLANE_URL` para sua origem e
`REMOTE_AUTH_WEBHOOK_SECRET` com o valor protegido da identidade do serviço de
contas. O Signal deve ter seus próprios segredos de sessão, métricas e TURN.
Não imprimir nem versionar esses valores. A API deriva o webhook de eventos da
origem do Signal. As integrações opcionais permanecem sujeitas às suas próprias
credenciais. Criação de VMs pagas pelo provedor upstream fica desativada neste alvo.

## Migração do app com preservação de identidade

Não basta substituir a URL. Uma conta nova com outro UUID pode deixar o host antigo
inativo, e reconciliar um diretório remoto vazio pode retirar servidores e pins da
configuração local. A sessão atual também pertence ao serviço anterior.

A troca deve seguir esta sequência:

1. Preservar o bundle anterior, perfil, workspace e dados do novo serviço. Encerrar
   normalmente o app antes de obter a cópia consistente; verificar a integridade.
2. Com a nova API ainda isolada, importar explicitamente o UUID e o e-mail normalizado
   do proprietário existente. Confirmar a propriedade desse e-mail pelo login do
   novo serviço. O E2E local prova essa continuidade com um usuário de teste.
3. Registrar o mesmo `serverId`, `ownerMembershipId` e chave pública do host. A chave
   privada fica no Mac. Conferir o diretório e os membros antes de permitir a
   reconciliação do aplicativo com a origem nova.
4. Preservar a sessão anterior no backup e configurar a origem da API e do Signal
   de modo persistente no aplicativo. Verificar abertura normal pelo Dock, além
   da execução pelo terminal. A implementação desse corte depende do domínio final.
5. Refazer convites no domínio novo e verificar aceite até o décimo membro,
   revogação, reativação, presença e reconexão de outro dispositivo. Convites e
   sessões do serviço anterior não são importados automaticamente. Se os membros
   existentes não puderem ser exportados do upstream, seus e-mails/identificadores
   e novo login precisam ser tratados explicitamente; não prometer cópia automática.
6. Manter a origem anterior como caminho de retorno até terminar a validação. A
   restauração deve usar o conjunto de configuração e sessão anterior compatíveis.

Não apontar o perfil principal para uma API vazia. Antes do corte, o app deve continuar usando sua conta anterior. A publicação da
Contabo e a configuração do app estão registradas na Evidência de implantação abaixo.

## Persistência e limites operacionais

Esta implantação inaugura o primeiro esquema de objetos do alvo VPS; não havia
versão VPS publicada antes dela. Bancos experimentais criados durante seu desenvolvimento não são uma
fonte de migração de produção. Mudanças futuras de esquema exigem migração explícita.

Executar uma única instância da API com o diretório exclusivo. SQLite e os objetos
precisam de volume local persistente, permissões restritas e espaço monitorado.
Não usar esse diretório em réplicas ou compartilhamento de rede. Os limitadores
curtos de requisição ficam na memória de cada processo; reiniciar os zera. A tabela
é limitada e recusa novos solicitantes quando cheia, sem expulsar limites ativos.

Os adaptadores cobrem as operações usadas pelo serviço e cenários E2E. Isso não
constitui paridade integral com os SDKs D1/R2; criptografia por chave individual
SSE-C, por exemplo, é recusada. O HTTPS, a proteção de disco e os backups pertencem
à instalação. Para backup consistente, parar o serviço e copiar o diretório inteiro,
incluindo arquivos auxiliares SQLite, com destino e permissões protegidos. Não
copiar somente o arquivo principal de um banco aberto em WAL. Testar restauração
em diretório separado antes de depender desse backup.

`/health/ready`, login, diretório, dez membros e persistência foram exercitados no
artefato local. A implantação da Contabo foi também verificada em produção conforme
a Evidência abaixo; o login da pessoa e a transferência WebRTC real permanecem
verificações distintas dos fixtures de operação.


## Implantação Contabo — 11/11/2026

Projeto Dokploy **OPENBOT**, ambiente **production**, stack **Contas, Signal e TURN**,
na VPS `95.111.234.71`. Entrada web: `https://openbot.harpia.digital/app`.
API: `https://openbot.harpia.digital`. Signal: `wss://openbot.harpia.digital/v1/signal`.
Estado: `/opt/openbot/state/accounts`; releases e operações em `/opt/openbot/`.
O stack gerenciado fica em `/etc/dokploy/compose/openbot-service/code/docker-compose.yml`.

`apps/auth-api/vps/compose.contabo.yaml` é o modelo desse destino. As imagens locais
são fixadas por fingerprint de fontes; os registros com os IDs das imagens ficam
em `/opt/openbot/records/`. O stack não depende de credenciais Cloudflare. Os
segredos são arquivos protegidos, montados somente nos serviços que os usam; o
launcher `load-secrets.sh` passa seus valores ao processo sem imprimi-los. Não
copiar esses arquivos para o chat nem para o checkout.

O proxy existente termina HTTPS e encaminha as rotas exatas do Signal, sem
interceptar as rotas da API. A saúde externa de Signal e TURN está em
`/_signal/health/ready` e `/_signal/health/turn`; esta última confirma alocação TURN
autenticada. O coturn usa TCP/UDP 3478, TLS 5349 e faixa UDP de relay 50000–50199.
Seu certificado é exportado somente para esse domínio no próprio host. O timer
`openbot-certificate-sync.timer` renova essa cópia a cada cinco minutos; o coturn
recarrega alterações do certificado. Nenhuma chave ACME sai da VPS.

O SMTP usa a conta de envio HARPIA já configurada na VPS, com Resend. O login
público desse transporte é `resend`, conforme a
[configuração oficial](https://resend.com/changelog/smtp-service), e não um endereço
de e-mail. A validação aceita essa combinação somente em `smtp.resend.com:465`;
a validação anterior continua vigente para outros hosts. O helper de senha do
Worker Private Email não deve ser usado para esses segredos da VPS.

Após um erro real no primeiro envio, publicamos essa correção e exercitamos o
endpoint `/v1/auth/email/start` usando o
[destinatário oficial de simulação](https://resend.com/changelog/sending-test-emails).
A API retornou 200, registrou `delivery_state=sent` e o SMTP confirmou a aceitação.
Esse teste não consome o desafio de login do proprietário nem prova chegada à sua
caixa pessoal. A entrada real deve ser concluída no aplicativo.

O app principal lê `<userData>/account-service-endpoints.json`; a instalação gravou
HTTPS/WSS desse domínio no perfil HarpiaTeam. A sessão anterior está preservada no
backup da instalação; o proprietário mantém UUID, hostId, membershipId, chave
pública e imagem do servidor. As chaves privadas dos hosts continuam no Mac.
Convites antigos continuam vinculados ao serviço anterior e precisam de novos
links no serviço próprio. Credenciais de integrações opcionais não são importadas
por essa implantação; o teste de Signal não valida essas integrações.

Evidência: [Publicação na Contabo](../specs/evidencias/contas-vps-contabo/Evidencia.md).
Para reverter o app, preservar o banco e workspace atuais e restaurar somente o
bundle e o conjunto compatível de configuração/sessão anterior, com o app fechado.
Não substituir dados posteriores por uma cópia antiga do perfil. Os backups da VPS
são consistentes por SQLite Backup API; os registros em `/opt/openbot/records/`
indicam seus diretórios protegidos. Ainda não há verificação de restauração em uma
VPS separada nem cópia de desastre fora desse host.
