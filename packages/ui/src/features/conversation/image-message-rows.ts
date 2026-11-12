import { removeAttachmentReferences } from "@openbot/contracts/attachment-references";
import type { AgentMessage } from "../../data";

/** A visual row only. Every member remains its original message, with its own ID and actions. */
export interface ImageMessageRow {
  id: string;
  messages: [AgentMessage, ...AgentMessage[]];
}

export function imageOnlyMessage(message: AgentMessage): boolean {
  const attachments = message.attachments;
  if (
    message.author !== "agent" ||
    !attachments?.length ||
    message.streaming ||
    (message.kind !== undefined && message.kind !== "text") ||
    message.actionMarker ||
    message.exchange ||
    message.questionPrompt ||
    message.replyToMessageId ||
    message.voiceRecording ||
    message.imageGeneration ||
    (message.itemType && message.itemType !== "agent_attachment") ||
    attachments.some((attachment) => attachment.previewKind !== "image")
  )
    return false;
  return (
    attachments.reduce((body, attachment) => removeAttachmentReferences(body, attachment.id), message.body).trim() ===
    ""
  );
}

/** Consecutive image-only messages share space, never storage, across all chat surfaces. */
export function imageMessageRows(
  messages: readonly AgentMessage[],
  options: {
    before?: ReadonlySet<string>;
    after?: ReadonlySet<string>;
  } = {},
): ImageMessageRow[] {
  const rows: ImageMessageRow[] = [];
  for (const message of messages) {
    const row = rows.at(-1);
    const previous = row?.messages.at(-1);
    const previousAt = previous?.createdAt ? new Date(previous.createdAt) : undefined;
    const currentAt = message.createdAt ? new Date(message.createdAt) : undefined;
    const sameDay =
      previousAt &&
      currentAt &&
      Number.isFinite(previousAt.getTime()) &&
      Number.isFinite(currentAt.getTime()) &&
      previousAt.toDateString() === currentAt.toDateString();
    const sameTurn =
      previous?.turnId !== undefined || message.turnId !== undefined
        ? previous?.turnId === message.turnId
        : Boolean(
            sameDay &&
              previousAt &&
              currentAt &&
              currentAt.getTime() >= previousAt.getTime() &&
              currentAt.getTime() - previousAt.getTime() <= 5 * 60_000,
          );
    if (
      row &&
      previous &&
      imageOnlyMessage(previous) &&
      imageOnlyMessage(message) &&
      sameTurn &&
      sameDay &&
      previousAt &&
      currentAt &&
      currentAt.getTime() >= previousAt.getTime() &&
      currentAt.getTime() - previousAt.getTime() < 60 * 60_000 &&
      previous.senderAgentId === message.senderAgentId &&
      previous.senderMember?.id === message.senderMember?.id &&
      !options.before?.has(message.id) &&
      !options.after?.has(previous.id)
    )
      row.messages.push(message);
    else rows.push({ id: message.id, messages: [message] });
  }
  return rows;
}
