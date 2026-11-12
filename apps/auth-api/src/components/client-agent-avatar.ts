import { createClientOnlyFn } from "@tanstack/solid-start";

/** These pages already mount avatars after hydration; their engine must not enter the server graph. */
export const loadClientAgentAvatar = createClientOnlyFn(() =>
  import("@openbot/ui/features/agents/AgentAvatar").then((module) => ({ default: module.AgentAvatar })),
);
