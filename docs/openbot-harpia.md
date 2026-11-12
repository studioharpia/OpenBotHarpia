# OpenBotHarpia

Repositório da distribuição mantida pela HARPIA:
[studioharpia/OpenBotHarpia](https://github.com/studioharpia/OpenBotHarpia).
O projeto deriva de [nightly-labs/openbot](https://github.com/nightly-labs/openbot).
Preservamos [LICENSE](../LICENSE), [NOTICE](../NOTICE) e a autoria original. O aplicativo, seus
identificadores e o formato dos dados não são renomeados pela mudança do repositório.

## Código e instaladores

A preparação inicial mantém a versão `0.65.0` e reúne as alterações locais da HARPIA. Publicar o
código não cria instaladores, não atualiza a instalação do usuário e não publica serviços.

Quem entra no Workspace da HARPIA pelo desktop precisa de uma distribuição configurada para o
nosso serviço de contas e Signal. O instalador upstream usa os serviços oficiais por padrão.
A entrada pelo navegador está disponível no próprio convite.

Consulte [serviço de contas na VPS](contas-vps.md) e [self-hosting](self-hosting.md) para a
configuração existente. Não utilize credenciais de produção como padrão de desenvolvimento.

## Remotos e publicação inicial

No checkout de trabalho, `origin` continua apontando para o projeto original. O remoto `harpia`
aponta para `https://github.com/studioharpia/OpenBotHarpia.git`. Isso preserva a origem e separa o
destino da nossa publicação. O histórico base foi recuperado sem trocar a branch ou o HEAD.

Antes do primeiro envio:

1. Regerar o inventário e conferir o diff, pois o checkout principal pode receber outras edições.
2. Selecionar explicitamente os arquivos revisados; preservar os dados locais ignorados.
3. Criar o commit em português e permitir a execução normal do pre-commit, sem `--no-verify`.
4. Publicar no remoto `harpia` somente quando o envio estiver autorizado. O destino inicial está
   vazio; a preparação não faz push nem abre PR.

Não executar `git add .`, force-push, troca de histórico ou envio de tags como atalho. Não tratar
o arquivo de código exportado como substituto da revisão do Git e dos hooks.

## Arquivos locais

Evidências operacionais, capturas, previews, dados de desenvolvimento, chaves privadas, bancos,
dependências instaladas e resultados de build permanecem locais. As regras de `.gitignore`
preservam esses arquivos no disco e evitam adicioná-los como novos arquivos ao repositório público.

Os três arquivos de ambiente compartilhados já rastreados continuam cifrados com dotenvx,
conforme as instruções do projeto. As chaves de descriptografia não acompanham o código. Um clone
sem essas chaves deve utilizar o carregador de desenvolvimento e seus padrões gerados, conforme
[configuração do serviço de contas](../apps/auth-api/README.md).

## CI e serviços externos

Os checks normais da CI permanecem habilitados. Os jobs herdados de deploy e preview do
Cloudflare ficam limitados ao repositório upstream; um push na HARPIA não autoriza deploy.
Os anúncios mobile no Discord, a publicação automática do runtime nativo e a política
herdada de contribuição também ficam restritos ao upstream.

O efeito visual LaserFlow é privado e continua excluído do código público. O componente da landing
e a CI aceitam sua ausência. O script herdado `scripts/deploy-auth-api.ts` exige esse asset: o
deploy da HARPIA deve seguir o procedimento próprio da VPS, não presumir acesso ao repositório
privado nem copiar o asset para este Git.

Workflows de assinatura, releases desktop/mobile, revisão NorbiAI, CLA e políticas de contribuição
são herdados e precisam de configuração específica antes de serem adotados pela HARPIA. Não criar
tags ou acionar publicação manual como parte do primeiro envio de código.

Não fizemos build geral nem executamos a suíte completa durante a preparação. A preparação dos
arquivos e as validações focadas existentes não equivalem a uma homologação de toda a versão;
os checks amplos permanecem a cargo da CI.

## Instalação sem assinatura paga da Apple

O código fica neste repositório. Compilar a partir dele exige o Bun e Node fixados
no projeto, dependências e ferramentas de empacotamento; o link do repositório por
si só não instala o aplicativo. Para usar o Workspace pelo navegador, abra o convite
e escolha continuar em `/app`, sem instalar o desktop.

O workflow manual `Pacote HARPIA para teste` compila o commit escolhido em runners
macOS, para Apple Silicon e Intel. Os artefatos incluem o aplicativo, commit e SHA-256.
Esses pacotes não são notarizados, não publicam um feed de atualização e precisam
de validação antes da distribuição ao time. Uma compilação de teste não comprova
assinatura de distribuição nem aprovação do Gatekeeper. A instalação deve preservar
o perfil existente; não remover `HarpiaTeam` nem redefinir agentes para atualizar.

O macOS pode exigir autorização manual em Ajustes do Sistema → Privacidade e
Segurança → Abrir Mesmo Assim. Siga a [orientação da Apple](https://support.apple.com/102445)
e confira a origem e o SHA-256 do download. A assinatura Developer ID e a notarização
são uma etapa opcional futura, sujeita à conta Apple Developer e certificados próprios.
