import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  CONVERSATION_MEMORY_CHANGES_ITEM_TYPE,
  CONVERSATION_PLAN_ITEM_TYPE,
  CONVERSATION_SUBAGENTS_ITEM_TYPE,
  CONVERSATION_TRACE_STEP_LIMIT,
  CONVERSATION_TRACE_TEXT_LIMIT,
  type ConversationMessage,
  type ConversationTraceStep,
  type ConversationTraceStepKind,
  type ConversationTurnTrace,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger, redactText } from "@openbot/logging";

const latencyLogger = createOpenBotLogger("message-latency");
export interface SteerTimingEvent {
  stage: "sent" | "accepted" | "failed";
  agentId: string;
  turnId: string;
  deliveryId: string;
  createdAt: string;
}

interface RunningTrace {
  startedAt: string;
  steps: Map<string, ConversationTraceStep>;
  openItems: Set<string>;
}

/**
 * Owns the steps of each running turn, by provider item id, until the turn ends. The providers send
 * no times, so each time is when the host got the event. A turn ends with `take`, which removes it;
 * only a turn that `begin` started records steps, so a compaction turn keeps nothing here.
 */
export class TurnTraces {
  readonly #turns = new Map<string, RunningTrace>();
  readonly #steers = new Map<
    string,
    {
      event: SteerTimingEvent;
      sentAt: number;
      acceptedAt: number | null;
      firstTextAt: number | null;
      priorItems: Set<string>;
    }
  >();

  /** Host-only metadata. An acknowledgement is not proof the model read the instruction. */
  steer(event: SteerTimingEvent): void {
    const now = Date.now();
    if (event.stage === "sent") {
      this.#steers.set(event.deliveryId, {
        event,
        sentAt: now,
        acceptedAt: null,
        firstTextAt: null,
        priorItems: new Set([
          ...(this.#turns.get(event.turnId)?.steps.keys() ?? []),
          ...(this.#turns.get(event.turnId)?.openItems ?? []),
        ]),
      });
    }
    const pending = this.#steers.get(event.deliveryId);
    if (!pending) return;
    if (event.stage === "accepted") pending.acceptedAt = now;
    latencyLogger.info("Message steering milestone.", {
      stage: event.stage,
      agentId: event.agentId,
      deliveryId: event.deliveryId,
      turnId: event.turnId,
      queueToRequestMs: Math.max(0, pending.sentAt - Date.parse(event.createdAt)),
      requestElapsedMs: now - pending.sentAt,
    });
    if (event.stage === "failed" || (event.stage === "accepted" && pending.firstTextAt !== null))
      this.#steers.delete(event.deliveryId);
  }

  /** Only a new assistant text item counts, not remaining deltas of an item already streaming. */
  assistantText(turnId: string, itemId: string): void {
    const now = Date.now();
    for (const [id, pending] of this.#steers) {
      if (pending.event.turnId !== turnId || pending.firstTextAt !== null || pending.priorItems.has(itemId)) continue;
      pending.firstTextAt = now;
      latencyLogger.info("First new assistant text after steering.", {
        agentId: pending.event.agentId,
        deliveryId: id,
        turnId,
        requestToFirstTextMs: now - pending.sentAt,
        acceptedToFirstTextMs: pending.acceptedAt === null ? null : now - pending.acceptedAt,
      });
      if (pending.acceptedAt !== null) this.#steers.delete(id);
    }
  }

  #finishSteers(turnId: string): void {
    for (const [id, pending] of this.#steers) {
      if (pending.event.turnId !== turnId) continue;
      if (pending.firstTextAt === null)
        latencyLogger.info("Steered turn ended without a new assistant text milestone.", {
          agentId: pending.event.agentId,
          deliveryId: id,
          turnId,
        });
      this.#steers.delete(id);
    }
  }

  begin(turnId: string, startedAt: string): void {
    this.#turns.set(turnId, { startedAt, steps: new Map(), openItems: new Set() });
  }

  /**
   * Records an item event. The first event of an item starts its step; a completion ends it. A later
   * event can change the kind between thinking and message, because Claude marks its thinking late.
   * `text` is the progress text of a tool step; the text of the first event stays. The command and the
   * recipients of a tool step come with its start, but a provider can send them later, so the first
   * event that has them sets them.
   */
  observe(
    turnId: string,
    itemId: string,
    kind: ConversationTraceStepKind,
    event: {
      completed: boolean;
      failed?: boolean;
      text?: string | null;
      command?: string | null;
      recipientAgentIds?: string[] | null;
      /** The redacted and cut error text of a failed step (`toolFailureText`). */
      error?: string | null;
    },
  ): void {
    const trace = this.#turns.get(turnId);
    // A step id must pass the message guard, or the message that holds the trace would not decode.
    if (!trace || !itemId || itemId.length > INPUT_LIMITS.identifier) return;
    if (event.completed) trace.openItems.delete(itemId);
    else trace.openItems.add(itemId);
    const now = new Date().toISOString();
    let step = trace.steps.get(itemId);
    if (!step) {
      if (trace.steps.size >= CONVERSATION_TRACE_STEP_LIMIT) return;
      step = { id: itemId, kind, startedAt: now, endedAt: null };
      trace.steps.set(itemId, step);
    }
    if (step.kind !== "tool") step.kind = kind;
    if (kind === "tool" && step.text === undefined && event.text)
      step.text = event.text.slice(0, CONVERSATION_TRACE_TEXT_LIMIT);
    // The trace stays on this computer, but a command can hold a token, as a log line can.
    const command = event.command?.trim();
    if (kind === "tool" && step.command === undefined && command)
      step.command = redactText(command).slice(0, CONVERSATION_TRACE_TEXT_LIMIT);
    if (kind === "tool" && step.recipientAgentIds === undefined && event.recipientAgentIds?.length)
      step.recipientAgentIds = [...event.recipientAgentIds];
    if (kind === "tool" && step.error === undefined && event.error) step.error = event.error;
    if (event.completed && step.endedAt === null) step.endedAt = now;
    if (event.completed && event.failed) step.failed = true;
  }

  /** The trace of a turn that ends now, without its usage. It removes the turn. */
  take(turnId: string, endedAt: string): ConversationTurnTrace | null {
    this.#finishSteers(turnId);
    const trace = this.#turns.get(turnId);
    this.#turns.delete(turnId);
    if (!trace) return null;
    return { startedAt: trace.startedAt, endedAt, steps: [...trace.steps.values()] };
  }

  drop(turnId: string): void {
    this.#finishSteers(turnId);
    this.#turns.delete(turnId);
  }

  clear(): void {
    this.#steers.clear();
    this.#turns.clear();
  }
}

/**
 * The message of a turn that holds its trace: its last answer with text, or its last thinking when
 * it has no answer. A question prompt, a plan, the subagents and the memory changes do not hold it.
 */
export function traceMessage(
  messages: readonly ConversationMessage[],
  turnId: string,
): ConversationMessage | undefined {
  let thinking: ConversationMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.author !== "assistant" || message.turnId !== turnId) continue;
    if (message.itemType === "commentary") {
      thinking ??= message;
      continue;
    }
    if (
      message.itemType === "question_prompt" ||
      message.itemType === CONVERSATION_PLAN_ITEM_TYPE ||
      message.itemType === CONVERSATION_SUBAGENTS_ITEM_TYPE ||
      message.itemType === CONVERSATION_MEMORY_CHANGES_ITEM_TYPE
    )
      continue;
    if (message.text.trim()) return message;
  }
  return thinking;
}
