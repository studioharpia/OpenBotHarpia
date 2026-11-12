import { createSignal } from "solid-js";
import { swallowNextClick } from "./thread-tab-drag";
import type { ThreadItem } from "./thread-types";

/** All three task views use the same host-scoped action; UI never chooses a second host. */
export interface TaskTransferActions {
  serverId: string;
  onTransfer: (agentId: string, taskId: string, targetAgentId: string) => void;
}
export interface TaskTransferSource {
  actions: TaskTransferActions;
  agentId: string;
}
interface Carry {
  source: TaskTransferSource;
  thread: ThreadItem;
  targetAgentId: string | null;
}
const [carried, setCarried] = createSignal<Carry | null>(null);
const [pointerHeld, setPointerHeld] = createSignal(false);
export const carriedTaskTransfer = carried;
export const taskTransferInProgress = () => pointerHeld() || carried() !== null;
let preview: HTMLElement | undefined;
let hiddenOrigin: HTMLElement | undefined;

export function clearTaskTransfer(): void {
  preview?.remove();
  preview = undefined;
  hiddenOrigin?.removeAttribute("data-task-transfer-source");
  hiddenOrigin = undefined;
  setCarried(null);
}

/** One floating preview for each task surface; the existing tab row still owns tab reordering. */
export function updateTaskTransfer(
  source: TaskTransferSource | undefined,
  thread: ThreadItem | undefined,
  x: number,
  y: number,
  origin: HTMLElement,
): boolean {
  if (!source || !thread || thread.kind !== "side" || ["working", "queued", "waiting"].includes(thread.status.kind))
    return false;
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-task-transfer-agent]");
  const targetId =
    target?.dataset.taskTransferServer === source.actions.serverId &&
    target.dataset.taskTransferAgent !== source.agentId
      ? (target.dataset.taskTransferAgent ?? null)
      : null;
  if (!preview) {
    const copy = origin.cloneNode(true);
    if (!(copy instanceof HTMLElement)) return false;
    preview = copy;
    preview.removeAttribute("id");
    for (const element of preview.querySelectorAll("[id]")) element.removeAttribute("id");
    preview.setAttribute("aria-hidden", "true");
    preview.inert = true;
    preview.classList.add("task-transfer-drag-preview");
    preview.style.width = `${Math.min(origin.getBoundingClientRect().width, 360)}px`;
    document.body.append(preview);
    hiddenOrigin = origin.closest<HTMLElement>(".sidebar-agent-thread, .agent-central-task-row") ?? origin;
    hiddenOrigin.setAttribute("data-task-transfer-source", "");
  }
  preview.style.left = `${x + 12}px`;
  preview.style.top = `${y + 12}px`;
  setCarried({ source, thread, targetAgentId: targetId });
  return targetId !== null;
}

export function finishTaskTransfer(cancel = false): boolean {
  const carry = carried();
  clearTaskTransfer();
  if (cancel || !carry?.targetAgentId) return false;
  carry.source.actions.onTransfer(carry.source.agentId, carry.thread.id, carry.targetAgentId);
  return true;
}

/** Pointer events work on all task rows without native drag competing with sidebar agent reorder. */
export function startTaskTransfer(
  event: PointerEvent,
  source: TaskTransferSource | undefined,
  thread: ThreadItem | undefined,
): void {
  if (
    !source ||
    !thread ||
    thread.kind !== "side" ||
    event.button !== 0 ||
    !event.isPrimary ||
    ["working", "queued", "waiting"].includes(thread.status.kind)
  )
    return;
  const origin = event.currentTarget;
  if (!(origin instanceof HTMLElement)) return;
  event.stopPropagation();
  // Prevent the browser from starting a native drag on the ancestor agent's draggable wrapper.
  event.preventDefault();
  setPointerHeld(true);
  const pointerId = event.pointerId;
  let moving = false;
  const move = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return;
    if (!moving && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 6) return;
    moving = true;
    next.preventDefault();
    updateTaskTransfer(source, thread, next.clientX, next.clientY, origin);
  };
  const finish = (next: Event) => {
    if (next instanceof PointerEvent && next.pointerId !== pointerId) return;
    if (next instanceof KeyboardEvent && next.key !== "Escape") return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    window.removeEventListener("keydown", finish);
    setPointerHeld(false);
    if (moving) {
      swallowNextClick();
      finishTaskTransfer(next.type !== "pointerup");
    }
  };
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
  window.addEventListener("keydown", finish);
}
