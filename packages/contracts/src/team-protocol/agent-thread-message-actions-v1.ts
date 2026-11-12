// Additive optional contract: side-thread message actions do not change agent-thread-reads-v1.
// A member with chat access can rewind their own task read cursor or change the user's reaction
// to a message of that task. The agent and task must belong together; hidden agents remain 404.
// Rewinding does not affect another member. Reactions follow the existing user-reaction semantics.
// Existing read routes keep their monotonic cursor. Protocols below 9 do not advertise this capability.
import { adminRoute, count, fields, identifier, nullable, type OptionalRouteCodec, string } from "./admin-wire";

export const AGENT_THREAD_MESSAGE_ACTIONS_CAPABILITY = "agent-thread-message-actions-v1";
export const AGENT_THREAD_MESSAGE_ACTIONS_ROUTES = {
  unread: "/v1/agent-threads/messages/unread-from",
  reaction: "/v1/agent-threads/messages/reaction",
} as const;
export const AGENT_THREAD_MESSAGE_ACTIONS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    AGENT_THREAD_MESSAGE_ACTIONS_ROUTES.unread,
    adminRoute(
      fields({ agentId: identifier, taskId: identifier, fromMessageId: identifier }),
      fields({
        taskId: identifier,
        unreadCount: count,
        firstUnreadMessageId: nullable(identifier),
        throughMessageId: nullable(identifier),
      }),
    ),
  ],
  [
    AGENT_THREAD_MESSAGE_ACTIONS_ROUTES.reaction,
    adminRoute(
      fields({ agentId: identifier, taskId: identifier, messageId: identifier, emoji: nullable(string(64)) }),
      fields({}),
    ),
  ],
]);
