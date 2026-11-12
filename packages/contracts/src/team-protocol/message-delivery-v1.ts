// Optional, frozen message-delivery-v1 contract. A chat-authorized member sends to the agent's
// own chat or an open task with a per-message queue/steer intent. A stale expected turn stays
// queued; unsupported providers and routine sessions also keep the message for its next turn.
// The host records the authenticated member as sender and preserves client-message idempotency.
import { isDynamicRecord } from "../runtime-values";
import { fields, identifier, list, nullable, type OptionalRouteCodec, oneOf, string } from "./admin-wire";
import { AGENT_TASKS_CODECS, AGENT_TASKS_ROUTES } from "./agent-tasks-v1";

export const MESSAGE_DELIVERY_CAPABILITY = "message-delivery-v1";
export const MESSAGE_DELIVERY_ROUTE = "/v1/agent-messages/send";
const decode = fields(
  {
    agentId: identifier,
    text: string(100_000),
    attachmentDraftIds: list(identifier, 10),
    deliveryMode: oneOf("queue", "steer"),
  },
  {
    taskId: identifier,
    clientMessageId: identifier,
    expectedTurnId: identifier,
    replyToMessageId: nullable(identifier),
    timezone: string(100),
  },
);
function request(input: unknown) {
  const value = decode(input);
  if (
    !isDynamicRecord(value) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.attachmentDraftIds) ||
    (!value.text.trim() && value.attachmentDraftIds.length === 0)
  )
    throw new Error("Message text or attachment is required.");
  return value;
}
const receipt = AGENT_TASKS_CODECS.get(AGENT_TASKS_ROUTES.send);
if (!receipt) throw new Error("Missing task receipt codec.");
export const MESSAGE_DELIVERY_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [MESSAGE_DELIVERY_ROUTE, { request, response: receipt.response }],
]);
