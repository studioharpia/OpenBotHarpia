### Changed

- Adicionamos openbot.transfer_task ao catálogo dos agentes. A ferramenta recebe a tarefa e o agente de destino, usa a identidade de quem chamou como origem e reutiliza a transferência entre agentes do mesmo servidor. Preserva histórico, anexos e não lidas sem iniciar trabalho. Recusa chamadas de canais, conversas externas e outras tarefas, destinos ocultos, tarefas alheias, rotinas e trabalho ativo ou pendente. Retries da mesma chamada são idempotentes; falhas de armazenamento não expõem caminhos internos.
