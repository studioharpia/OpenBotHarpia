import type { AgentMessage } from "../../data";

/** The layout and its date separators use one time; the original stored time is never changed. */
export function messageRowCreatedAt(message: AgentMessage | undefined): string | undefined {
  let latest = message?.createdAt;
  if (message?.kind === "thinking") {
    for (const at of message.itemCreatedAt ?? []) {
      const time = Date.parse(at);
      if (Number.isFinite(time) && (!Number.isFinite(Date.parse(latest ?? "")) || time > Date.parse(latest ?? "")))
        latest = at;
    }
  }
  return latest;
}

/**
 * Chronological display only: storage, provider turns and read cursors retain their original order.
 * A steps disclosure belongs after its latest thought, rather than at the first thought's time.
 * Rows without a timestamp retain their relative order at the end.
 */
export function chronologicalMessageRows(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages
    .map((message, index) => {
      const createdAt = Date.parse(messageRowCreatedAt(message) ?? "");
      return { message, index, at: Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER };
    })
    .sort((left, right) => left.at - right.at || left.index - right.index)
    .map(({ message }) => message);
}
