// Frozen optional agent-task-transfer-v1 contract, protocol 9 only, requires agent-tasks-v1.
// POST moves a retained idle task to a different agent on this host. Both require chat access.
// The same thread/message/attachment/read-cursor identities stay. Routine and pending work refuse.
// requestId identifies one intent; retries never move a task a second time.
import { adminRoute, empty, fields, identifier, type OptionalRouteCodec } from "./admin-wire";
export const AGENT_TASK_TRANSFER_CAPABILITY = "agent-task-transfer-v1";
export const AGENT_TASK_TRANSFER_ROUTE = "/v1/agent-tasks/transfer";
export const AGENT_TASK_TRANSFER_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    AGENT_TASK_TRANSFER_ROUTE,
    adminRoute(
      fields({ agentId: identifier, taskId: identifier, targetAgentId: identifier, requestId: identifier }),
      empty,
    ),
  ],
]);
