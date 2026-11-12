# Independent channel execution

One agent can run turns in different channels at the same time when its provider supports concurrent turns. Each channel retains its existing durable execution thread and ordered mailbox lane. Related messages in the same channel stay ordered; ordinary agent tasks retain their own execution threads. A task transfer still waits for the previous assignment. Stop and cancel retain their existing per-task semantics.

Set `MERLIM_EXECUTION_CONCURRENCY` in the host process environment before startup to a positive safe integer, for example `6` or `10`. It limits the combined active task and channel lanes of each agent. It does not impose a fixed maximum of four. The own chat remains separate. Missing or invalid values use the agent's existing task limit (default four). The frozen Team API and existing settings UI remain compatible and keep their existing 1–4 range; this host override takes precedence over that setting. No new UI or wire protocol is introduced.

A provider that permits only one turn still serializes its agent's lanes. Provider plan holds, host turn slots, low-memory holds, and explicit workspace/browser resource conflicts still apply. Lowering the limit does not interrupt running work. The override is an operator budget, not an estimate of available RAM; choose it for the host and provider. This change does not add desktop memory-pressure monitoring where none existed.

## Evidência

Run `/Users/lukaslemos/.codex/bin/codex-heavy -- bun scripts/channel-session-isolation-e2e.ts` locally. CI runs the same script without the local launcher. It starts the real AgentService, scheduler, SQLite store and Codex adapter in a temporary profile, with a controlled child provider process. It holds turns open until explicitly released. No installed app, live account, personal conversation, or production database is used.

The report records distinct provider sessions, overlapping channel turns, the configured slot limit, independent stop/cancel, packet isolation, continuation on the same provider session, and replies persisted to their channel. This is service integration evidence; live provider behavior, UI, restart recovery and the installed application are not validated by this harness.
