// Optional agent-task-limit-v2 contract. Requires protocol 9 and agent-tasks-v1.
// Admin settings accept null (host default, still 4) or 1..10. The separate list route and
// agent-tasks-changed-v2 event expose the real limit. All other task routes keep their v1 meaning.
// Providers that serialize turns and host memory holds still take precedence. Lowering a limit
// never interrupts a running turn. Older peers keep the v1 projection, capped at 4.
import { type AgentTasksSnapshot, isAgentTasksSnapshot } from "../ipc-agent-tasks";
import { isDynamicRecord } from "../runtime-values";
import { type AdminDecoder, adminRoute, fields, identifier, nullable, type OptionalRouteCodec } from "./admin-wire";
import { AGENT_TASKS_CODECS, AGENT_TASKS_ROUTES, type AgentTasksEvent } from "./agent-tasks-v1";

export const AGENT_TASK_LIMIT_V2_CAPABILITY = "agent-task-limit-v2";
export const AGENT_TASK_LIMIT_V2_ROUTES = {
  settings: "/v2/admin/agents/task-limit",
  update: "/v2/admin/agents/task-limit/update",
  list: "/v2/agent-tasks/list",
} as const;

const limit: AdminDecoder = (input) => {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 10)
    throw new Error("Invalid agent task limit.");
  return input;
};
const taskLimit = nullable(limit);
const settings = fields({ taskLimit });
const legacyList = AGENT_TASKS_CODECS.get(AGENT_TASKS_ROUTES.list);
if (!legacyList) throw new Error("Missing frozen agent tasks list codec.");
const frozenList = legacyList;

/** Reuse the frozen task records; only the snapshot limit has a new bound. */
const snapshot: AdminDecoder = (input) => {
  if (!isDynamicRecord(input)) throw new Error("Invalid agent tasks snapshot.");
  const nextLimit = limit(input.limit);
  const decoded = frozenList.response(200, { ...input, limit: 4 });
  if (!isDynamicRecord(decoded)) throw new Error("Invalid agent tasks snapshot.");
  return { ...decoded, limit: nextLimit };
};

export const AGENT_TASK_LIMIT_V2_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [AGENT_TASK_LIMIT_V2_ROUTES.settings, adminRoute(fields({ agentId: identifier }), settings)],
  [AGENT_TASK_LIMIT_V2_ROUTES.update, adminRoute(fields({ agentId: identifier, taskLimit }), settings)],
  [AGENT_TASK_LIMIT_V2_ROUTES.list, adminRoute(frozenList.request, snapshot)],
]);

/** Unknown events are ignored. A malformed v2 task snapshot fails closed. */
export function agentTaskLimitV2Event(input: unknown): AgentTasksEvent | null {
  if (!isDynamicRecord(input) || input.type !== "agent-tasks-changed-v2") return null;
  const decoded = snapshot(input.snapshot);
  if (!isAgentTasksSnapshot(decoded)) throw new Error("Invalid agent tasks event.");
  return { type: "agent-tasks-changed", snapshot: decoded };
}

/** Permanent projection for the released v1 readers, without changing the host setting. */
export function legacyAgentTasksSnapshot(value: AgentTasksSnapshot): AgentTasksSnapshot {
  return { ...value, limit: Math.min(value.limit, 4) };
}
