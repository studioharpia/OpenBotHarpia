import {
  assertHostAnalyticsScope,
  decodeHostAnalytics,
  type HostAnalytics,
  type HostAnalyticsInput,
  hostAnalyticsQuery,
} from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  HOST_TASK_COMPLETIONS_CAPABILITY,
  HOST_TASK_COMPLETIONS_ROUTE,
} from "@openbot/contracts/team-protocol/host-task-completions-v1";
import { Effect } from "effect";
import { AnalyticsRequestError } from "./agent-analytics";

export const readHostAnalytics = Effect.fn("TeamClient.readHostAnalytics")(function* (
  request: <T>(method: "GET", path: string, decode: (value: unknown) => T) => Promise<T>,
  capabilities: readonly string[],
  input: HostAnalyticsInput,
): Effect.fn.Return<HostAnalytics | null, AnalyticsRequestError> {
  if (!capabilities.includes("host-analytics")) return null;
  const path = capabilities.includes(HOST_TASK_COMPLETIONS_CAPABILITY)
    ? HOST_TASK_COMPLETIONS_ROUTE
    : TEAM_API_ROUTES.analytics;
  return yield* Effect.tryPromise({
    try: () =>
      request("GET", `${path}?${hostAnalyticsQuery(input)}`, (value) =>
        assertHostAnalyticsScope(decodeHostAnalytics(value), input),
      ),
    catch: (cause) => new AnalyticsRequestError({ cause }),
  });
});
