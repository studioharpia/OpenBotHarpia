import type { AgentTask } from "@openbot/contracts/ipc";
import { z } from "zod";

const readsSchema = z.record(z.string(), z.string());

/** A presentation acknowledgement, scoped to this server and browser profile. */
export const taskFailureStorageKey = (serverId: string) => `openbot:task-failure-reads:v1:${serverId}`;

export function taskFailureVersion(task: AgentTask): string | undefined {
  if (task.state === "running" || task.state === "queued") return undefined;
  // updatedAt changes when a turn ends; renaming does not change it.
  return task.outcome === "failed" || task.outcome === "interrupted" ? `${task.outcome}:${task.updatedAt}` : undefined;
}

export function readTaskFailureReads(key: string): Record<string, string> {
  try {
    const parsed = readsSchema.safeParse(JSON.parse(window.localStorage.getItem(key) ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeTaskFailureRead(key: string, taskId: string, version: string): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...readTaskFailureReads(key), [taskId]: version }));
  } catch {
    // Without storage, this window still remembers the acknowledgement until it closes.
  }
}
