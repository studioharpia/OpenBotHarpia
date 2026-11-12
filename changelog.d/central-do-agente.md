### Changed

- Implementamos a Central do agente no painel direito, com avatar, nome, cargo e atividade de tokens em quadrados. Reformulamos a lista de tarefas com abertura lateral ou no chat, renomeação, arquivamento e restauração. Reutilizamos os componentes e as operações existentes, preservamos o chat no centro e mantivemos a preferência por Central, Configurações ou painel fechado ao navegar entre agentes do mesmo servidor.

- Completamos as bordas da grade com quadrados neutros, preservando as datas e os valores dos dias reais.

- Mantivemos uma largura compartilhada e persistida entre todas as abas do painel direito e habilitamos o redimensionamento também no chat lateral das tarefas.

- Reorganizamos as métricas em três cards lado a lado, com grade mensal alinhada, tokens usados e tarefas finalizadas. Incluímos a seleção de mês atual ou anterior e mantivemos o intervalo sincronizado nos três cards.

- Padronizamos as tarefas da Central com os ícones, fontes e menus da barra lateral. Alinhamos ícone, título, data e menu em uma linha e ajustamos o clique para abrir a tarefa na coluna principal. Reutilizamos também a exclusão com opção de desfazer.

- Melhoramos o cabeçalho da Central com nome em destaque, cargo, status e adaptação à largura do painel. Substituímos as abas de tarefas por seções recolhíveis de Concluídas, Em andamento e Arquivadas, com preferência salva para todos os agentes e sincronizada entre janelas. Arquivadas começa recolhida quando ainda não há uma escolha salva.

- Removemos os fundos e bordas das métricas da Central e adotamos a tipografia dos totais da página Uso. Compactamos os quadrados para preencher a coluna e representar o mês inteiro, mantendo datas futuras sem consumo inventado.

- Ajustamos os cabeçalhos e as tarefas da Central para exibir fundo somente no hover, sem preenchimento fixo em seções abertas, recolhidas ou tarefas selecionadas. Preservamos o indicador de foco por teclado.

- Adicionamos bordas discretas e levemente arredondadas às três colunas de métricas, sem fundo, e centralizamos seu conteúdo verticalmente. Removemos a linha de datas inferior e mantivemos o acesso a Uso junto ao seletor de mês.

- Corrigimos Tarefas finalizadas para usar a primeira conclusão bem-sucedida registrada no banco, com o fuso e o mês selecionados. Incluímos tarefas arquivadas e além do limite da lista, sem depender das mensagens do chat. Renomear, restaurar ou executar novos turnos não desloca a conclusão original. Preservamos contratos remotos antigos e disponibilizamos o indicador a hosts compatíveis por uma nova capability opcional.

- Corrigimos o indicador de tarefas não lidas na Central, usando o mesmo estado e a mesma bolinha da barra lateral. A leitura no chat principal atualiza o indicador pelo fluxo existente.

- Posicionamos a bolinha de não lido antes da hora para manter a data e o menu alinhados. Agilizamos o empacotamento local ao desativar consultas remotas de timestamp, mantendo o certificado Apple, a assinatura e a verificação estrita do bundle. O fluxo de releases notarizadas permanece com sua configuração original.
