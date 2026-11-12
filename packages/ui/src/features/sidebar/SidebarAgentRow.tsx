import { avatarHeadColor } from "@openbot/brand/bloub-avatar";
import { carriedTaskTransfer, taskTransferInProgress } from "../conversation/threads/task-transfer-drag";
/**
 * One agent in a section: the drag wrapper, the row itself, and its context menu.
 *
 * A waiting agent's row sits in the "Needs you" group instead. There it does not drag, because the
 * group is not a place in the layout, and its tooltip says what the agent waits for.
 *
 * A hidden agent's row sits in the "Hidden" group. It does not drag either. It sleeps, shows no state,
 * and shows when the user hid it in place of the last message.
 */

import { AppWindow, Badge, buttonVariants, Clock3, ContextMenu, Lock } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import { agentAccessLockLabel } from "../agents/agent-access";
import { ThreadTabIcon } from "../conversation/threads/ThreadStatusMark";
import { MAIN_THREAD_ID } from "../conversation/threads/thread-types";
import { SidebarAgentContextMenu } from "./SidebarAgentContextMenu";
import { SidebarAgentIndicator, SidebarWaitChip, SidebarWaitTooltip } from "./SidebarAgentIndicator";
import { SidebarAgentThreads } from "./SidebarAgentThreads";
import { sidebarAgentStateLabel, sidebarMessageTime, sidebarUsageResetTime } from "./sidebar-filtering";
import { useSidebarScope } from "./sidebar-scope";

/**
 * `waiting` is set by the "Needs you" group. The row reads it rather than the agent's state, because
 * the group holds its members still during a drag while the state moves on. `userHidden` is set by
 * the "Hidden" group.
 */
export function SidebarAgentRow(rowProps: {
  agent: AgentProfile;
  waiting?: boolean;
  userHidden?: boolean;
  pinned?: boolean;
}) {
  const {
    dragOffset,
    draggedChatId,
    endChatDragging,
    layoutMutable,
    props,
    sidebarClickIsSuppressed,
    startChatDragging,
    userHiddenSince,
  } = useSidebarScope();
  const { t, format } = useText();
  const selected = () =>
    props.activeAgentId === rowProps.agent.id &&
    (!props.agentThreads || props.agentThreads.activeId(rowProps.agent.id) === MAIN_THREAD_ID);
  const title = () => rowProps.agent.title.trim();
  const lockLabel = () => agentAccessLockLabel(rowProps.agent, t);
  const accessLabel = () => (lockLabel() ? `. ${lockLabel()}` : "");
  const inWindow = () => props.windowAgentIds?.has(rowProps.agent.id) ?? false;
  const windowLabel = () => (inWindow() ? `. ${t("sidebar.agentMenu.inWindow")}` : "");
  const state = () => (rowProps.userHidden ? undefined : props.agentStates[rowProps.agent.id]);
  const unread = () => {
    const current = state();
    return current?.kind === "unread" ? current.count : 0;
  };
  const failedRoutine = () => {
    const current = state();
    return current?.kind === "routine" && current.phase === "failed";
  };
  const avatarState = () => {
    const current = state();
    return !props.compact && (current?.kind === "unread" || (failedRoutine() && !props.compactAgentRows))
      ? undefined
      : current;
  };
  const hiddenDetail = () => {
    const since = rowProps.userHidden ? userHiddenSince(rowProps.agent.id) : undefined;
    return since
      ? t("sidebar.hidden.since", { date: format.date(new Date(since), { month: "short", day: "numeric" }) })
      : "";
  };
  // A function, not a JSX ternary: the compiler wraps a ternary in a memo, and the avatar reads its
  // mood inside an effect, where a memo cannot be created.
  const mood = () => (rowProps.userHidden ? "asleep" : (props.agentMoods[rowProps.agent.id] ?? "idle"));
  const hiddenLabel = () => (rowProps.userHidden ? `${t("sidebar.hidden.title")}. ` : "");
  const draggable = () =>
    !taskTransferInProgress() &&
    layoutMutable() &&
    !props.compact &&
    !rowProps.waiting &&
    !rowProps.userHidden &&
    !rowProps.pinned;
  const wait = () => {
    const current = state();
    return rowProps.waiting && current?.kind === "waiting" ? current : undefined;
  };
  // A waiting row previews the question: the stored preview is the message before it.
  const detail = () => hiddenDetail() || wait()?.detail || rowProps.agent.preview;
  // The state label already reads the question, so the label does not say it twice.
  const labelDetail = () => (wait()?.detail ? "" : `. ${hiddenLabel()}${detail()}`);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const limit = () => {
    const current = state();
    return current?.kind === "limited" ? current : undefined;
  };
  const stateLabel = () => {
    const current = state();
    return current?.kind === "routine" || current?.kind === "waiting" || current?.kind === "limited"
      ? sidebarAgentStateLabel(current, t, format)
      : "";
  };
  const routineLabel = () => (state()?.kind === "routine" || limit() ? stateLabel() : "");
  // Only a waiting row has a tooltip, so the rows in the sections do not each carry one.
  const unreadIndicator = () => (
    <span
      class="agent-threads-state agent-threads-unread sidebar-agent-unread"
      style={{
        "--openbot-unread-surface": avatarHeadColor(
          rowProps.agent.avatarSeed ?? rowProps.agent.id,
          rowProps.agent.avatarHue ?? null,
          rowProps.agent.avatarColor ?? null,
        ),
      }}
      title={t("sidebar.state.unread", { count: unread() })}
      aria-hidden="true"
    />
  );
  const row = (): JSX.Element => (
    <ContextMenu.Root modal={false} onOpenChange={setMenuOpen}>
      <ContextMenu.Trigger
        as="button"
        type="button"
        class={[
          buttonVariants({ variant: "ghost" }),
          "agent-row",
          {
            "agent-row-active": selected(),
            "sidebar-agent-row-dragging": draggedChatId() === rowProps.agent.id,
          },
        ]}
        data-task-transfer-agent={props.taskTransfer ? rowProps.agent.id : undefined}
        data-task-transfer-server={props.taskTransfer?.serverId}
        data-task-transfer-active={
          carriedTaskTransfer()?.targetAgentId === rowProps.agent.id &&
          carriedTaskTransfer()?.source.actions.serverId === props.taskTransfer?.serverId
            ? ""
            : undefined
        }
        aria-label={`${rowProps.agent.name}${title() ? `, ${title()}` : ""}${accessLabel()}${windowLabel()}${labelDetail()}${unread() > 0 ? `. ${t("sidebar.state.unread", { count: unread() })}` : ""}${stateLabel() ? `. ${stateLabel()}` : ""}`}
        title={routineLabel() || undefined}
        aria-pressed={selected() ? "true" : "false"}
        data-attention={failedRoutine() ? "failed" : state()?.kind === "waiting" ? "waiting" : undefined}
        data-cuelume-navigate=""
        onClick={(event: MouseEvent) => {
          if (!sidebarClickIsSuppressed(event)) props.onSelectAgent(rowProps.agent.id);
        }}
      >
        <span class="agent-row-avatar">
          <AgentAvatar agent={rowProps.agent} motion="idle" mood={mood()} workingFaces />
          <SidebarAgentIndicator state={avatarState} />
        </span>
        <span class="agent-row-copy">
          <span class="agent-row-heading">
            <span class="agent-row-title">
              <span class="agent-row-name">
                <strong dir="auto">{rowProps.agent.name}</strong>
                <Show when={lockLabel()}>
                  <span class="agent-row-access" title={lockLabel()}>
                    <Lock aria-hidden="true" />
                  </span>
                </Show>
                <Show when={inWindow()}>
                  <span class="agent-row-access" title={t("sidebar.agentMenu.inWindow")}>
                    <AppWindow aria-hidden="true" />
                  </span>
                </Show>
              </span>
              <Show when={title()}>
                {(label) => (
                  <Badge
                    class="agent-role-badge agent-role-badge-colored"
                    title={label()}
                    style={{
                      "--agent-role-color": avatarHeadColor(
                        rowProps.agent.avatarSeed ?? rowProps.agent.id,
                        rowProps.agent.avatarHue ?? null,
                        rowProps.agent.avatarColor ?? null,
                      ),
                    }}
                  >
                    <span dir="auto">{label()}</span>
                  </Badge>
                )}
              </Show>
            </span>
            <Show
              when={props.compactAgentRows}
              fallback={
                <Show
                  when={wait()}
                  fallback={
                    <Show
                      when={limit()}
                      fallback={
                        <Show when={!rowProps.userHidden}>
                          <span class="agent-row-time">
                            {rowProps.agent.updatedAt
                              ? sidebarMessageTime(rowProps.agent.updatedAt, format)
                              : rowProps.agent.time}
                          </span>
                        </Show>
                      }
                    >
                      {(current) => (
                        <span class="agent-row-wait-chip">
                          <Clock3 aria-hidden="true" />
                          {sidebarUsageResetTime(current().resetsAt, format) ?? t("sidebar.state.usageLimitChip")}
                        </span>
                      )}
                    </Show>
                  }
                >
                  {(current) => <SidebarWaitChip reason={current().reason} />}
                </Show>
              }
            >
              <Show when={!rowProps.userHidden}>
                <span class="agent-row-time">
                  {rowProps.agent.updatedAt
                    ? sidebarMessageTime(rowProps.agent.updatedAt, format)
                    : rowProps.agent.time}
                </span>
              </Show>
            </Show>
            <Show when={props.compactAgentRows && !props.compact && unread() > 0}>{unreadIndicator()}</Show>
          </span>
          <Show when={!props.compactAgentRows}>
            <span class="agent-row-preview-line">
              <span class="agent-row-preview" dir="auto">
                {detail()}
              </span>
              <Show when={!props.compact && failedRoutine()}>
                <span class="sidebar-agent-thread-icon" title={stateLabel()} aria-hidden="true">
                  <ThreadTabIcon status={{ kind: "failed" }} />
                </span>
              </Show>
              <Show when={!props.compact && unread() > 0}>{unreadIndicator()}</Show>
            </span>
          </Show>
        </span>
        <Show when={state()}>
          {(state) => <span class="sr-only">{sidebarAgentStateLabel(state(), t, format)}</span>}
        </Show>
      </ContextMenu.Trigger>
      <SidebarAgentContextMenu
        agent={rowProps.agent}
        pinned={rowProps.pinned === true}
        userHidden={rowProps.userHidden === true}
      />
    </ContextMenu.Root>
  );
  return (
    /* biome-ignore lint/a11y/noStaticElementInteractions: Native drag belongs to the wrapper around the accessible button. */
    <div
      class={[
        "sidebar-agent-item",
        {
          "sidebar-agent-item-user-hidden": rowProps.userHidden === true,
          "sidebar-agent-item-dragging": draggedChatId() === rowProps.agent.id,
          "sidebar-drag-shifting": dragOffset(rowProps.agent.id).y !== 0,
        },
      ]}
      style={`--sidebar-drag-y: ${dragOffset(rowProps.agent.id).y}px;`}
      data-chat-id={rowProps.waiting || rowProps.userHidden || rowProps.pinned ? undefined : rowProps.agent.id}
      draggable={draggable() ? "true" : "false"}
      onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) => startChatDragging(event, rowProps.agent.id)}
      onDragEnd={endChatDragging}
    >
      <Show when={wait()} fallback={row()}>
        {(current) => (
          <SidebarWaitTooltip wait={current()} menuOpen={menuOpen()}>
            {row()}
          </SidebarWaitTooltip>
        )}
      </Show>
      <Show when={!rowProps.userHidden}>
        <SidebarAgentThreads agentId={rowProps.agent.id} />
      </Show>
    </div>
  );
}
