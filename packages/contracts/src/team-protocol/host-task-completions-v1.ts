// Optional host-task-completions-v1 contract. Requires host-analytics and protocol 9.
// GET has the same scoped date query as host analytics. Each retained task counts once,
// on its first persisted successful turn completion in the requested time zone.
// Archived tasks count; messages, rename/restore dates and subsequent turns do not.
// No completion timestamp means no dated completion, rather than a guessed date.
import { isDynamicRecord } from "../runtime-values";
import { adminRoute, count, empty, type OptionalRouteCodec } from "./admin-wire";
import { decodeHostAnalyticsV1Response } from "./host-analytics-v1";

export const HOST_TASK_COMPLETIONS_CAPABILITY = "host-task-completions-v1";
export const HOST_TASK_COMPLETIONS_ROUTE = "/v1/analytics/task-completions";
export const HOST_TASK_COMPLETIONS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    HOST_TASK_COMPLETIONS_ROUTE,
    adminRoute(empty, (value) => {
      if (!isDynamicRecord(value)) throw new Error("Invalid task completion analytics.");
      return { ...decodeHostAnalyticsV1Response(value), completedTasks: count(value.completedTasks) };
    }),
  ],
]);
