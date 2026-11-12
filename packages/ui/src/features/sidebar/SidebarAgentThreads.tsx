import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { Archive, buttonVariants, ContextMenu, Input, MessageSquare, PencilLine, Trash2, X } from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { TaskMark, type TaskMarkState } from "../conversation/TaskList";
import { ThreadStatusText, threadAttention } from "../conversation/threads/ThreadStatusMark";
import { ThreadTitle } from "../conversation/threads/ThreadTitle";
import { startTaskTransfer } from "../conversation/threads/task-transfer-drag";
import { type ThreadItem, threadBusy } from "../conversation/threads/thread-types";
import { SidebarWaitIcon } from "./SidebarAgentIndicator";
import { useSidebarScope } from "./sidebar-scope";

function SidebarAgentThread(props: { agentId: string; thread: ThreadItem }) {
  const { props: sidebar, sidebarClickIsSuppressed } = useSidebarScope();
  const { t } = useText();
  const [renaming, setRenaming] = createSignal(false);
  const selected = () =>
    sidebar.activeAgentId === props.agentId && sidebar.agentThreads?.activeId(props.agentId) === props.thread.id;
  const side = () => props.thread.kind === "side";
  const busy = () => threadBusy(props.thread.status);
  const mark = (): TaskMarkState => {
    if (props.thread.status.kind === "working") return "active";
    if (props.thread.status.kind === "failed") return "failed";
    return props.thread.status.kind === "idle" && props.thread.outcome === "completed" ? "done" : "pending";
  };
  const finishRename = (value: string | null) => {
    if (!renaming()) return;
    setRenaming(false);
    const title = value?.trim();
    if (title && title !== props.thread.title) sidebar.agentThreads?.onRename?.(props.agentId, props.thread.id, title);
  };
  return (
    <li class="sidebar-agent-thread">
      <Show
        when={renaming()}
        fallback={
          <ContextMenu.Root>
            <ContextMenu.Trigger
              as="button"
              type="button"
              class={[buttonVariants({ variant: "ghost" }), "sidebar-agent-thread-button"]}
              draggable="false"
              onPointerDown={(event) =>
                startTaskTransfer(
                  event,
                  sidebar.taskTransfer ? { actions: sidebar.taskTransfer, agentId: props.agentId } : undefined,
                  props.thread,
                )
              }
              title={props.thread.title}
              aria-pressed={selected() ? "true" : "false"}
              data-attention={threadAttention(props.thread.status)}
              data-cuelume-navigate=""
              onContextMenu={(event) => event.stopPropagation()}
              onClick={(event: MouseEvent) => {
                if (!sidebarClickIsSuppressed(event)) sidebar.agentThreads?.onOpen(props.agentId, props.thread.id);
              }}
            >
              <span
                class="sidebar-agent-thread-icon sidebar-agent-task-status"
                data-status={props.thread.status.kind}
                aria-hidden="true"
              >
                <Show
                  when={props.thread.status.kind === "waiting" ? props.thread.status.reason : undefined}
                  fallback={<TaskMark state={mark()} />}
                >
                  {(reason) => <SidebarWaitIcon reason={reason()} />}
                </Show>
              </span>
              <Show when={mark() === "done"}>
                <span class="sr-only">{t("conversation.tasks.state.completed")}</span>
              </Show>
              <ThreadTitle class="sidebar-agent-thread-title" title={props.thread.title} />
              <Show when={(props.thread.unread ?? 0) > 0}>
                <span class="sidebar-agent-thread-icon" aria-hidden="true">
                  <span class="agent-threads-state agent-threads-unread" />
                </span>
              </Show>
              <ThreadStatusText status={props.thread.status} unread={props.thread.unread} />
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content class="agent-threads-tab-menu" aria-label={t("conversation.threads.actions")}>
                <ContextMenu.Item onSelect={() => sidebar.agentThreads?.onOpen(props.agentId, props.thread.id)}>
                  <MessageSquare aria-hidden="true" />
                  <span>{t("common.open")}</span>
                </ContextMenu.Item>
                <Show when={side() && sidebar.agentThreads?.onRename}>
                  <ContextMenu.Item onSelectAfterClose={() => setRenaming(true)}>
                    <PencilLine aria-hidden="true" />
                    <span>{t("common.rename")}</span>
                  </ContextMenu.Item>
                </Show>
                <Show when={!side() && sidebar.agentThreads?.onCloseDraft}>
                  <ContextMenu.Separator />
                  <ContextMenu.Item
                    onSelect={() => sidebar.agentThreads?.onCloseDraft?.(props.agentId, props.thread.id)}
                  >
                    <X aria-hidden="true" />
                    <span>{t("common.close")}</span>
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    class="ui-action-menu-danger"
                    onSelect={() => sidebar.agentThreads?.onCloseDraft?.(props.agentId, props.thread.id)}
                  >
                    <Trash2 aria-hidden="true" />
                    <span>{t("common.delete")}</span>
                  </ContextMenu.Item>
                </Show>
                <Show when={side()}>
                  <ContextMenu.Separator />
                  <ContextMenu.Item
                    disabled={busy()}
                    onSelect={() => sidebar.agentThreads?.onArchive(props.agentId, props.thread.id)}
                  >
                    <Archive aria-hidden="true" />
                    <span>{t("conversation.threads.archive")}</span>
                  </ContextMenu.Item>
                  <Show when={sidebar.agentThreads?.onDelete}>
                    <ContextMenu.Item
                      class="ui-action-menu-danger"
                      disabled={busy() || props.thread.status.kind === "queued"}
                      onSelect={() => sidebar.agentThreads?.onDelete?.(props.agentId, props.thread.id)}
                    >
                      <Trash2 aria-hidden="true" />
                      <span>{t("common.delete")}</span>
                    </ContextMenu.Item>
                  </Show>
                </Show>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        }
      >
        <Input
          ref={(field: HTMLInputElement) =>
            requestAnimationFrame(() => {
              field.focus();
              field.select();
            })
          }
          class="sidebar-agent-thread-rename"
          size="sm"
          dir="auto"
          aria-label={t("conversation.threads.name")}
          maxlength={INPUT_LIMITS.agentTaskTitle}
          defaultValue={props.thread.title}
          onKeyDown={(event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finishRename(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finishRename(null);
            }
          }}
          onBlur={(event: FocusEvent & { currentTarget: HTMLInputElement }) => finishRename(event.currentTarget.value)}
        />
      </Show>
    </li>
  );
}

/** The same threads and status icons as the chat tabs, nested under their agent. */
export function SidebarAgentThreads(props: { agentId: string }) {
  const { props: sidebar } = useSidebarScope();
  const { t } = useText();
  const items = () =>
    (sidebar.agentThreads?.items(props.agentId) ?? []).filter(
      (thread) => !sidebar.unreadOnly || (thread.unread ?? 0) > 0,
    );
  return (
    <Show when={!sidebar.compact && sidebar.view !== "routines" && items().length > 0}>
      <ul class="sidebar-agent-threads" aria-label={t("conversation.threads.open")}>
        <For each={items()} keyed={(thread) => thread.id}>
          {(thread) => <SidebarAgentThread agentId={props.agentId} thread={thread()} />}
        </For>
      </ul>
    </Show>
  );
}
