import {
  MESSAGE_DELIVERY_CAPABILITY,
  MESSAGE_DELIVERY_ROUTE,
} from "@openbot/contracts/team-protocol/message-delivery-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import { parseSendMessage } from "../ipc/agent-inputs";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { memberSender, readJson, requireAgentLevel, requireListedAgent } from "./request-helpers";

/** Optional atomic send intent; the released message routes retain their host-preference behavior. */
export async function routeMessageDelivery(
  context: TeamApiRequestContext,
  agents: TeamApiAgents,
  hidden: ReadonlySet<string>,
): Promise<RouteOutcome> {
  if (context.method !== "POST" || context.url.pathname !== MESSAGE_DELIVERY_ROUTE) return "unmatched";
  if (!context.capabilities.has(MESSAGE_DELIVERY_CAPABILITY))
    throw new HttpError(400, sourceText("error.backend.threadRemoteUnsupported"));
  const body = await readJson(context.request);
  const input = parseSendMessage(body);
  if (hidden.has(input.agentId)) throw new HttpError(404, sourceText("error.team.agentNotFound"));
  requireListedAgent(agents, input.agentId);
  requireAgentLevel(context, input.agentId, "chat");
  // The optional wire decoder validates the timezone string; Intl validates the zone itself.
  const timezone = typeof body.timezone === "string" ? body.timezone : undefined;
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      throw new HttpError(400, "Invalid time zone.");
    }
  }
  return context.json(202, await runCauseEffect(agents.sendMessage(input, memberSender(context.member), timezone)));
}
