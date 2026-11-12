import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentTask,
  analyticsRange,
  analyticsTokens,
  type HostAnalytics,
  LOCAL_SERVER_ID,
  type ServerSummary,
} from "@openbot/contracts/ipc";
import { AGENT_NOTIFICATION_LEVELS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-notification-levels-v1";
import { BROWSER_PROFILES_CAPABILITY } from "@openbot/contracts/team-protocol/browser-profiles-v1";
import { isAgentTaskActive } from "@openbot/team-client/agent-tasks";
import { classifyFailure } from "@openbot/telemetry";
import {
  Archive,
  ArchiveRestore,
  Badge,
  Button,
  buttonVariants,
  ChevronDown,
  DropdownMenu,
  Ellipsis,
  ExternalLink,
  Input,
  MessageSquare,
  PencilLine,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Settings,
  Trash2,
} from "@openbot/ui";
import { PanelResizer } from "@openbot/ui/components/PanelResizer";
import {
  SETTINGS_PANEL_DEFAULT,
  SETTINGS_PANEL_MAX,
  SettingsPanel,
  SettingsPanelContent,
  SettingsPanelHeader,
} from "@openbot/ui/components/SettingsPanel";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { BROWSER_NEW_TAB_URL } from "@openbot/ui/features/browser/browser-suggestions";
import { type AgentTaskWait, agentTaskStatus } from "@openbot/ui/features/conversation/AgentTasks";
import { SidePanelHeader, SidePanelLauncher, type SidePanelPane } from "@openbot/ui/features/conversation/SidePanel";
import { SideQuestionPanel } from "@openbot/ui/features/conversation/SideQuestionPanel";
import { SubagentPanel } from "@openbot/ui/features/conversation/Subagents";
import { TaskMark, type TaskMarkState } from "@openbot/ui/features/conversation/TaskList";
import {
  startTaskTransfer,
  ThreadTitle,
  threadAttention,
} from "@openbot/ui/features/conversation/threads/ThreadHeader";
import { MAIN_THREAD_ID } from "@openbot/ui/features/conversation/threads/thread-types";
import { VoicePanel } from "@openbot/ui/features/conversation/VoicePanel";
import { McpSignInRelayDialog } from "@openbot/ui/features/settings/McpSignInPage";
import { ProfileHeatmap } from "@openbot/ui/features/settings/ProfileActivity";
import { SidebarWaitIcon } from "@openbot/ui/features/sidebar/SidebarAgentIndicator";
import { sidebarMessageTime } from "@openbot/ui/features/sidebar/sidebar-filtering";
import { usageCompact } from "@openbot/ui/features/usage/usage-format";
import { useText } from "@openbot/ui/text";
import { actionToast } from "../../action-toast";
import { savePanelWidth } from "../../components/panel-width-storage";
import { deviceQuoteShortcut } from "../../send-shortcut-preference";
import { type AgentTemplatePublishCalls, agentTemplatesPort } from "../agent-templates/agent-templates-port";
import { createPublishAgent } from "../agent-templates/PublishAgent";
import { desktopBrowserProfileCalls } from "../browser/browser-profiles-port";
import type { AgentFilesOptions } from "../files/AgentFilesSettings";
import { canManageStorage, serverHasStorage } from "../files/storage-usage";
import { serverCanAdminister, serverSupportsCapability } from "../servers/server-capabilities";
import { codexLiveAccess } from "../speech/codex-live-access";
import { speechPort } from "../speech/speech-port";
import { cycleSpeechSpeed, speechSpeed } from "../speech/speech-speed";
import { usagePort } from "../usage/usage-port";
import { ConversationSideThread } from "./ConversationSideThread";
import { setCentralTaskSectionCollapsed, useCentralTaskSections } from "./central-task-sections";
import { isChatVisualAppShortcut } from "./chat-visual-shortcuts";
import { htmlAttachmentPageHtml, htmlAttachmentPageUrl } from "./chat-visual-url";
import { useConversationController } from "./conversation-controller-context";
import { type AgentNotificationLevelCalls, conversationRuntime } from "./conversation-runtime";
import { useConversationViewScope } from "./conversation-scope";
import { agentSkillsMode } from "./installed-skills-source";
import { desktopChatEventRoutinesApi } from "./routine-webhooks-api";
import { createCodexLiveConversation } from "./stores/codex-live-conversation-store";
import type { VoiceConversationKind } from "./stores/voice-session-store";

const BROWSER_PANEL_DEFAULT_RATIO = 0.5;
const BROWSER_PANEL_MIN = 220;
const BROWSER_PANEL_MAX = 1600;
const CONVERSATION_PANEL_MIN = 96;
const loadAgentSettingsPanel = () => import("./AgentSettingsPanel");

import { type HostFolderPick, HostFolderPicker } from "@openbot/ui/features/conversation/HostFolderPicker";
import { Portal } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  createUniqueId,
  For,
  Loading,
  lazy,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import {
  agentFolderCalls,
  agentInstructionsCalls,
  browseHostFolders,
  type HostFolderPickFn,
  remoteAgentFolderCalls,
} from "./agent-folders-port";
import { conversationPort } from "./conversation-port";

/**
 * The voice conversation with the agent that is open when the pane opens. An agent on this computer,
 * or on a joined server with `live-voice-v1`, uses Codex live voice when the user turned it on in
 * Settings → Voice, whatever the agent's provider: the voice sends each request to the agent. A failed read of that setting keeps the conversation that
 * transcribes on this computer. A conversation that still runs from an earlier visit to the pane shows again.
 */
function VoiceConversationPane() {
  const controller = useConversationController();
  const { props } = useConversationViewScope();
  const running = untrack(() => (props.agent ? controller.voiceSessions.running(props.agent.id) : null));
  // Live voice runs in the Codex App Server of the agent's server. An older joined server cannot start
  // it, so its agents transcribe. Without a ChatGPT sign-in of that server's Codex, the voice transcribes.
  const codex = untrack(
    () =>
      (props.server?.kind !== "remote" || serverSupportsCapability(props.server, "live-voice-v1")) &&
      codexLiveAccess(props.agentStatus.providers) !== "signIn",
  );
  const [kind, setKind] = createSignal<VoiceConversationKind | null>(running ?? (codex ? null : "transcribed"));
  if (!running && codex)
    void speechPort()
      .voice.getSpeechSettings()
      .then(
        (settings) => setKind(settings.codexLive ? "codex-live" : "transcribed"),
        () => setKind("transcribed"),
      );
  return (
    <Show when={kind()} keyed>
      {(next) => <VoiceConversation kind={next} />}
    </Show>
  );
}

function VoiceConversation(paneProps: { kind: VoiceConversationKind }) {
  const controller = useConversationController();
  const { props, startVoiceConversation, closeSidePanelPane } = useConversationViewScope();
  const agentId = untrack(() => props.agent?.id);
  if (!agentId) return null;
  const serverId = untrack(() => props.server?.id ?? LOCAL_SERVER_ID);
  const kind = untrack(() => paneProps.kind);
  // The conversation outlives this pane: another tab or chat keeps it, and closing the Voice tab ends it.
  const conversation = controller.voiceSessions.open(agentId, kind, () =>
    kind === "codex-live" ? createCodexLiveConversation({ agentId, serverId }) : startVoiceConversation(agentId),
  );
  // Codex live voice speaks at the speed of the realtime model, so it has no speed button.
  const transcribed = kind === "transcribed";
  const replySpeed = () => (transcribed ? speechSpeed() : undefined);
  const cycleSpeed = transcribed ? cycleSpeechSpeed : undefined;
  return (
    <Show when={props.agent}>
      {(agent) => (
        <VoicePanel
          agent={agent()}
          phase={conversation.phase()}
          muted={conversation.muted()}
          heard={conversation.heard()}
          said={conversation.said()}
          levels={conversation.levels()}
          error={conversation.error()}
          onToggleMute={conversation.toggleMute}
          onInterrupt={conversation.interrupt}
          onEnd={() => closeSidePanelPane("voice")}
          speed={replySpeed()}
          onCycleSpeed={cycleSpeed}
        />
      )}
    </Show>
  );
}

/** @internal Stable HMR boundary for conversation panels. */
export function ConversationPanels(panelProps: { onOpenUsage?: ((trigger: HTMLButtonElement) => void) | undefined }) {
  const controller = useConversationController();
  const {
    agentReady,
    activateBrowserTab,
    activeBrowserTab,
    agentActivity,
    browserSidebarOpen,
    browserExpandedOpen,
    browserTabs,
    closeShownSidePanelFile,
    closeBrowserTab,
    downloadSidebarFile,
    revealSidebarFile,
    conversationPanelElement,
    filePreviewOpen,
    filesOpen,
    openBrowserAddress,
    openExternalMessageUrl,
    openRoutineRunMessage,
    openSharedFile,
    previewAttachment,
    openSidebarFileExternally,
    openWorkspaceFolder,
    openWorkspaceFolderEntry,
    previewQuoteId,
    previewFileKey,
    previewWorkspaceAgentId,
    quoteSelection,
    addPageText,
    setPageContext,
    sidebarFileBack,
    openSidebarFileBack,
    props,
    setActiveRightPanel,
    setBrowserPanelWidth,
    setSettingsPanelWidth,
    settingsPanelWidth,
    handleRoutineSettingsRequest,
    sidebarFilePreview,
    settingsOpen,
    skillSettingsRequest,
    instructionsSettingsRequest,
    routineSettingsRequest,
    settingsModel,
    settingsProvider,
    settingsReasoning,
    updateRuntimeSettings,
    fastMode,
    fastModeChange,
    messageLinkRelay,
    openMessageLinkRelay,
    pasteMessageLinkRelay,
    cancelMessageLinkRelay,
    activeRightPanel,
    sidePanel,
    sidePanelOpen,
    setSidePanelMaximized,
    openSidePanelPane,
    toggleSidePanel,
    closeSidePanelPane,
    openSidePanelFile,
    closeSidePanelFile,
    moveSidePanelFile,
    sideQuestion,
    setSideQuestionDraft,
    askSideQuestion,
    installedSkills,
    installedSkillsLoadFailed,
    mcpServers,
    voiceConversationAvailable,
    panelSubagentId,
    shownPanelThreadId,
    openPanelThread,
    closePanelThread,
    movePanelThreadToChat,
    channel,
  } = useConversationViewScope();
  const { t, format, errorMessage } = useText();
  const [centralTaskUi, setCentralTaskUi] = createStore<{
    ownerId: string | undefined;
    renaming: string | null;
    name: string;
  }>({ ownerId: undefined, renaming: null, name: "" });
  createEffect(
    () => props.agent?.id,
    (ownerId) => {
      setCentralTaskUi(() => ({ ownerId, renaming: null, name: "" }));
    },
  );
  const [centralMonth, setCentralMonth] = createSignal<"current" | "previous">("current");
  const centralPeriod = createMemo(() => {
    const today = analyticsRange(props.agent?.id ?? "", 1);
    const date = new Date(`${today.endDate}T12:00:00Z`);
    const month = date.getUTCMonth() - (centralMonth() === "previous" ? 1 : 0);
    const startDate = new Date(Date.UTC(date.getUTCFullYear(), month, 1)).toISOString().slice(0, 10);
    const lastDate = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).toISOString().slice(0, 10);
    return { ...today, startDate, endDate: centralMonth() === "previous" ? lastDate : today.endDate };
  });
  const [centralUsage, setCentralUsage] = createStore<{
    agentId: string | undefined;
    serverId: string;
    rangeKey: string;
    phase: "loading" | "ready" | "unsupported" | "error";
    result: HostAnalytics | null;
  }>({ agentId: undefined, serverId: LOCAL_SERVER_ID, rangeKey: "", phase: "loading", result: null });
  createEffect(
    () => ({
      visible: activeRightPanel() === "central",
      period: centralPeriod(),
      agentId: props.agent?.id,
      serverId: props.server?.id ?? LOCAL_SERVER_ID,
      calls: props.usagePort ?? (props.runtime ? undefined : usagePort()),
    }),
    ({ visible, agentId, serverId, calls, period }) => {
      if (!visible || !agentId) return;
      let active = true;
      let generation = 0;
      const rangeKey = `${period.startDate}:${period.endDate}`;
      setCentralUsage(() => ({ agentId, serverId, rangeKey, result: null, phase: calls ? "loading" : "unsupported" }));
      const load = async (background = false) => {
        if (!calls) return;
        const request = ++generation;
        try {
          const result = await calls.agent.getHostAnalytics({ ...period, agentId }, serverId);
          if (active && request === generation)
            setCentralUsage(() => ({ agentId, serverId, rangeKey, result, phase: result ? "ready" : "unsupported" }));
        } catch {
          if (active && request === generation && !(background && centralUsage.result))
            setCentralUsage(() => ({ agentId, serverId, rangeKey, result: null, phase: "error" }));
        }
      };
      void load();
      const unsubscribe = calls?.agent.onScopedEvent((event) => {
        if (
          event.serverId === serverId &&
          ((event.event.type === "turn-completed" && event.event.agentId === agentId) ||
            (event.event.type === "agent-tasks-changed" && event.event.snapshot.agentId === agentId))
        )
          void load(true);
      });
      return () => {
        active = false;
        unsubscribe?.();
      };
    },
  );
  const centralReport = () =>
    centralUsage.agentId === props.agent?.id &&
    centralUsage.serverId === (props.server?.id ?? LOCAL_SERVER_ID) &&
    centralUsage.rangeKey === `${centralPeriod().startDate}:${centralPeriod().endDate}`
      ? centralUsage.result
      : null;
  const centralActivity = createMemo(() => {
    const report = centralReport();
    const period = centralPeriod();
    const start = new Date(`${period.startDate}T00:00:00Z`);
    const count = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    const daily = new Map(report?.daily.map((day) => [day.date, day]));
    const days = Array.from({ length: count }, (_, index) => {
      const time = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), index + 1));
      const date = time.toISOString().slice(0, 10);
      const day = daily.get(date);
      return { date, weekday: time.getUTCDay(), tokens: day ? analyticsTokens(day) : 0, messages: 0 };
    });
    return {
      days,
      unavailable: new Set(
        days
          .filter((day) => {
            const row = daily.get(day.date);
            return !report || day.date > period.endDate || (row?.processedTokens === 0 && row.missingUsageTurns > 0);
          })
          .map((day) => day.date),
      ),
    };
  });
  const centralCompletedCount = () => centralReport()?.completedTasks ?? null;
  const centralTokens = () => {
    const report = centralReport();
    return report && (report.totals.processedTokens > 0 || report.totals.missingUsageTurns === 0)
      ? analyticsTokens(report.totals)
      : null;
  };
  const collapsedSections = useCentralTaskSections();
  const centralSectionsId = createUniqueId();
  const centralTaskGroups = createMemo(() => {
    const threads = props.threads;
    const byId = new Map(threads?.tasks.map((task) => [task.id, task]));
    const open =
      threads?.header.threads.flatMap((thread) => {
        const task = byId.get(thread.id);
        return task ? [task] : [];
      }) ?? [];
    const completed = (task: AgentTask) => !isAgentTaskActive(task) && task.outcome === "completed";
    return [
      { id: "completed", label: "conversation.central.completedTasks", tasks: open.filter(completed) },
      { id: "active", label: "conversation.central.inProgressTasks", tasks: open.filter((task) => !completed(task)) },
      {
        id: "archived",
        label: "conversation.central.archivedTasks",
        tasks:
          threads?.header.archived.flatMap((thread) => {
            const task = byId.get(thread.id);
            return task ? [task] : [];
          }) ?? [],
      },
    ] as const;
  });
  const centralStatus = createMemo(() => {
    const agentId = props.agent?.id;
    const wait = agentId ? props.agentWaits?.[agentId] : undefined;
    if (wait?.kind === "limited") return { kind: "waiting", label: t("sidebar.state.usageLimit") };
    const waitingThread = props.threads?.header.threads.find((thread) => thread.status.kind === "waiting");
    const reason =
      wait?.kind === "waiting"
        ? wait.reason
        : waitingThread?.status.kind === "waiting"
          ? waitingThread.status.reason
          : undefined;
    if (reason)
      return {
        kind: "waiting",
        label:
          reason === "approval"
            ? t("sidebar.state.waitingApproval")
            : reason === "takeover"
              ? t("sidebar.state.waitingTakeover")
              : t("sidebar.state.waitingQuestion"),
      };
    if (props.activeTurnId || agentActivity() === "Working" || (props.threads?.running ?? 0) > 0)
      return { kind: "working", label: t("conversation.central.statusRunning") };
    if (props.threads?.tasks.some((task) => task.state === "queued"))
      return { kind: "waiting", label: t("conversation.tasks.state.queued") };
    if (props.agentStatus.phase === "starting" || props.agentStatus.phase === "restarting" || props.agentsConnecting)
      return { kind: "starting", label: t("conversation.central.statusStarting") };
    if (props.agentStatus.phase === "ready" && props.agentStatus.capabilities.chat === "ready")
      return { kind: "ready", label: t("conversation.central.statusReady") };
    return { kind: "unavailable", label: t("conversation.central.statusUnavailable") };
  });
  const openCentralMain = () => {
    props.threads?.header.onOpen(MAIN_THREAD_ID);
    queueMicrotask(() => controller.setComposerFocusRequest((value) => value + 1));
    if (props.loaded && props.unreadCount > 0)
      void props.onMarkRead().catch(() => actionToast.error(t("chat.unread.markReadFailed")));
  };
  const centralTaskThread = (taskId: string) =>
    [...(props.threads?.header.threads ?? []), ...(props.threads?.header.archived ?? [])].find(
      (thread) => thread.id === taskId,
    );
  const centralTaskMark = (task: AgentTask): TaskMarkState => {
    const status = centralTaskThread(task.id)?.status.kind;
    if (status === "working") return "active";
    if (status === "failed") return "failed";
    return status === "idle" && task.outcome === "completed" ? "done" : "pending";
  };
  const centralTaskWaitReason = (taskId: string) => {
    const status = centralTaskThread(taskId)?.status;
    return status?.kind === "waiting" ? status.reason : undefined;
  };
  const centralTaskWait = (taskId: string): AgentTaskWait => {
    const status = props.threads?.header.threads.find((thread) => thread.id === taskId)?.status;
    return status?.kind === "waiting" ? (status.reason === "approval" ? "approval" : "answer") : undefined;
  };
  function startCentralRename(task: AgentTask) {
    setCentralTaskUi((state) => {
      state.ownerId = task.agentId;
      state.renaming = task.id;
      state.name = task.title;
    });
  }
  function finishCentralRename(value: string | null) {
    const id = centralTaskUi.renaming;
    const ownerId = centralTaskUi.ownerId;
    setCentralTaskUi((state) => {
      state.renaming = null;
    });
    const title = value?.trim();
    if (
      id &&
      title &&
      ownerId === props.agent?.id &&
      props.threads?.tasks.find((task) => task.id === id)?.title !== title
    )
      props.threads?.header.onRename?.(id, title);
  }
  function openCentralTask(task: AgentTask) {
    if (task.state === "closed") {
      props.threads?.header.onRestore(task.id);
    } else {
      props.threads?.side.onToChat(task.id);
    }
  }
  /** The web client asks the host. Desktop asks main, which asks a joined server's host. */
  const publishCalls = (): AgentTemplatePublishCalls => {
    if (props.runtime?.admin) return props.runtime.admin.agentTemplates;
    const server = props.server;
    if (server?.kind !== "remote") return agentTemplatesPort().agentTemplates;
    const { agent } = agentTemplatesPort();
    return {
      preview: (agentId) => agent.previewAgentTemplate(agentId, server.id),
      publish: (input) => agent.publishAgentTemplate(input, server.id),
      unpublish: (agentId) => agent.unpublishAgentTemplate(agentId, server.id),
    };
  };
  const publishAgent = createPublishAgent((url) => void conversationRuntime(props).openUrl(url), publishCalls);
  // This computer reads the skills of its own agents from the workspace. A joined host publishes its
  // own agents, for an owner or admin, when it serves `agent-publish-v1`.
  // A remote agent's host resolves its settings, so the account defaults of this computer do not apply.
  const localAgentDefaults = () => (props.server?.kind === "local" ? props.agentDefaults : undefined);
  const localFolderCalls = agentFolderCalls();
  // An agent's folders are on the computer that runs it. A joined server serves them through
  // `agent-folders-v1` for an owner or admin, and the folder browser lists the folders of the host.
  const [folderPick, setFolderPick] = createSignal<
    (HostFolderPick & { serverId: string; agentId: string; done: (path: string | null) => void }) | null
  >(null);
  const finishFolderPick = (path: string | null) => {
    const pick = folderPick();
    setFolderPick(null);
    pick?.done(path);
  };
  const folderServerId = createMemo(() =>
    props.server?.kind === "remote" && serverCanAdminister(props.server, "agent-folders-v1")
      ? props.server.id
      : undefined,
  );
  const folderCalls = createMemo(() => {
    if (props.runtime) return undefined;
    if (props.server?.kind === "local") return localFolderCalls;
    const serverId = folderServerId();
    if (serverId === undefined) return undefined;
    const pick: HostFolderPickFn = (agentId, mode, start) =>
      new Promise((done) => {
        // A pick that is still open closes as a cancel.
        folderPick()?.done(null);
        const agentName = props.agent?.id === agentId ? props.agent.name : "";
        setFolderPick({ mode, agentName, start, serverId, agentId, done });
      });
    return remoteAgentFolderCalls(serverId, pick);
  });
  const browsePickFolders = (path: string | null) => {
    const pick = folderPick();
    if (!pick) return Promise.reject(new Error(t("agentSettings.folders.browse.failed")));
    return browseHostFolders(pick.serverId, pick.agentId, path);
  };
  const openInstructionsLink = (url: string) => void openExternalMessageUrl(url);
  const localInstructions = { ...agentInstructionsCalls(), openLink: openInstructionsLink };
  // The file on this computer, or on a joined server that lets an owner or admin edit it. The calls
  // follow the server id, so a new summary of the same server keeps the open page.
  const instructionsServerId = createMemo(() =>
    props.server?.kind === "remote" && serverCanAdminister(props.server, "agent-instructions-v1")
      ? props.server.id
      : undefined,
  );
  const instructionsCalls = createMemo(() => {
    if (props.runtime) return undefined;
    if (props.server?.kind === "local") return localInstructions;
    const serverId = instructionsServerId();
    return serverId === undefined ? undefined : { ...agentInstructionsCalls(serverId), openLink: openInstructionsLink };
  });
  const canPublish = () =>
    props.runtime
      ? props.runtime.admin !== undefined && serverCanAdminister(props.server, "agent-publish-v1")
      : props.server?.kind === "local" ||
        (props.server?.kind === "remote" && serverCanAdminister(props.server, "agent-publish-v1"));
  // The web client asks the host directly; desktop goes through main for this computer and for a joined server.
  // The calls follow the server id, so a new summary of the same server keeps the loaded profiles.
  const browserProfileServerId = createMemo(() =>
    props.server && serverSupportsCapability(props.server, BROWSER_PROFILES_CAPABILITY) ? props.server.id : undefined,
  );
  const browserProfileCalls = createMemo(() => {
    if (props.runtime) return props.runtime.browserProfiles;
    const serverId = browserProfileServerId();
    return serverId === undefined ? undefined : desktopBrowserProfileCalls(serverId);
  });
  // Any member keeps an own level for each agent. The calls follow the server id, as above, and a
  // new server gets new calls, so its panel does not show the levels of the server before.
  const notificationLevelServerId = createMemo(() =>
    props.server && serverSupportsCapability(props.server, AGENT_NOTIFICATION_LEVELS_CAPABILITY)
      ? props.server.id
      : undefined,
  );
  const notificationLevelCalls = createMemo((): AgentNotificationLevelCalls | undefined => {
    const serverId = notificationLevelServerId();
    if (serverId === undefined) return undefined;
    const remote = props.runtime;
    if (remote) {
      const calls = remote.agentNotificationLevels;
      return calls ? { list: () => calls.list() } : undefined;
    }
    return {
      list: () => conversationPort().agent.listAgentNotificationLevels(serverId),
      subscribe: (listener) =>
        conversationPort().agent.onScopedEvent((scoped) => {
          if (scoped.serverId === serverId && scoped.event.type === "agent-notification-levels-changed")
            listener({ server: scoped.event.server, agents: scoped.event.agents });
        }),
    };
  });
  const openNotificationSettings = (trigger: HTMLElement) => {
    const serverId = props.server?.id;
    if (serverId) props.onOpenNotificationSettings?.(serverId, trigger);
  };
  let browserPreviewTrigger: HTMLButtonElement | undefined;
  /** The panes this chat can open. The web client has no Files pane, and a chat without a thread has no files. */
  const sidePanelPanes = createMemo((): SidePanelPane[] => [
    ...(props.agent && !channel ? (["central"] as const) : []),
    // A channel turn's takeover still shows as a card; the pane belongs to one agent's browser.
    ...(props.browserEnabled !== false && !channel ? (["browser"] as const) : []),
    ...(!props.runtime && props.agent?.threadId && serverHasStorage(props.server) ? (["files"] as const) : []),
    ...(props.agent || channel ? (["settings"] as const) : []),
    ...(props.agent && voiceConversationAvailable() ? (["voice"] as const) : []),
  ]);
  /** The subagent in the Subagent pane, from the newest turn that has it. */
  const panelSubagent = createMemo(() => {
    const subagentId = panelSubagentId();
    if (!subagentId) return undefined;
    for (let index = props.messages.length - 1; index >= 0; index -= 1) {
      const found = props.messages[index]?.subagents?.find((subagent) => subagent.id === subagentId);
      if (found) return found;
    }
    return undefined;
  });
  const settingsMaxWidth = () =>
    Math.min(
      SETTINGS_PANEL_MAX,
      Math.max(
        SETTINGS_PANEL_DEFAULT,
        (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
      ),
    );
  /** Agent settings > Files. */
  const agentFiles = (server: ServerSummary | undefined, agentId: string): AgentFilesOptions | undefined => {
    // The web client shows host files in Server settings > Storage; its agent settings have no Files.
    if (props.runtime || !serverHasStorage(server)) return undefined;
    return {
      serverId: server.id,
      canManage: canManageStorage(server),
      onOpenWorkspace:
        server.kind === "local"
          ? () =>
              void conversationPort()
                .storage.openLocation({ agentId })
                .catch((error) =>
                  actionToast.error(t("conversation.panels.openWorkspaceFailed"), {
                    ...{
                      description: errorMessage(error, t("conversation.panels.tryAgain")),
                    },
                    report: { operation: "turn", source: "action", cause_code: classifyFailure(error) },
                  }),
                )
          : undefined,
      onPreviewFile: (file) => void previewAttachment(file),
      onShowMessage: (messageId) => void openRoutineRunMessage(messageId),
      // The agent's chat is behind the settings, so closing them opens it.
      onOpenConversation: () => setActiveRightPanel("none"),
    };
  };
  createEffect(
    () => ({ expanded: browserExpandedOpen(), suspended: props.globalOverlayOpen || props.remoteDesktopVisible }),
    ({ expanded, suspended }) => {
      if (!expanded || suspended) return;
      const frame = conversationPanelElement()?.closest<HTMLElement>(".app-frame");
      if (!frame) return;
      const wasInert = frame.inert;
      frame.inert = true;
      return () => {
        frame.inert = wasInert;
      };
    },
  );
  createEffect(browserSidebarOpen, (open, previous) => {
    if (open && previous === false) onSettled(() => browserPreviewTrigger?.focus());
  });
  /**
   * A plain accessor, not a conditional in the prop: the compiler makes that a memo, and the tabs read
   * it first in an effect callback when the last tab closes, which halts the reactive system.
   */
  const selectedPane = () => (activeRightPanel() === "side-panel" ? null : sidePanel().selected);
  /** The side thread that shows, and whose tab is selected. */
  const shownThread = () => (activeRightPanel() === "thread" ? shownPanelThreadId() : null);
  /** The browser tabs that an agent acts in now. Their previews show the page more often. */
  const busyBrowserTabIds = createMemo(
    () => new Set(props.browserControlState.sessions.flatMap((session) => (session.tabId ? [session.tabId] : []))),
  );
  /** With no side thread to show, the side panel lists the panes. */
  const launcherShown = () =>
    activeRightPanel() === "side-panel" || (activeRightPanel() === "thread" && shownPanelThreadId() === null);
  /** The file that shows, and whose tab is selected. */
  const shownFile = () => (filePreviewOpen() ? sidePanel().file : null);
  /** Opens the routine's side thread in the chat, and closes the settings that cover it. */
  const openRoutineThread = async (routineId: string): Promise<boolean> => {
    const opened = (await props.threads?.onOpenRoutineThread(routineId)) ?? false;
    if (opened) setActiveRightPanel("none");
    return opened;
  };
  const sideThreadTabs = () => props.threads?.side.tabs ?? [];
  const moveSideThread = (id: string, index: number) => props.threads?.side.onMove(id, index);
  return (
    <>
      <HostFolderPicker request={folderPick()} browse={browsePickFolders} onDone={finishFolderPick} />
      <Show when={sidePanelOpen()}>
        <PanelResizer
          class="right-panel-resizer side-panel-resizer"
          label={t("settings.panel.resize")}
          controls="conversation-side-panel-tabs"
          direction="right"
          value={settingsPanelWidth()}
          defaultValue={SETTINGS_PANEL_DEFAULT}
          min={SETTINGS_PANEL_DEFAULT}
          max={settingsMaxWidth}
          onResize={setSettingsPanelWidth}
          onResizeEnd={(width) => savePanelWidth("openbot:side-panel-width", width)}
        />
        <SidePanelHeader
          panes={sidePanel().panes}
          selected={selectedPane()}
          available={sidePanelPanes()}
          maximized={sidePanel().maximized}
          settingsLabel={channel ? t("channel.settings.title") : undefined}
          onSelect={openSidePanelPane}
          onClose={closeSidePanelPane}
          threads={{
            items: sideThreadTabs(),
            selectedId: shownThread(),
            onSelect: openPanelThread,
            onClose: closePanelThread,
            onMove: moveSideThread,
            onToChat: movePanelThreadToChat,
          }}
          files={{
            items: sidePanel().files,
            selectedKey: shownFile(),
            onSelect: openSidePanelFile,
            onClose: closeSidePanelFile,
            onMove: moveSidePanelFile,
          }}
          onToggleMaximized={() => setSidePanelMaximized(!sidePanel().maximized)}
          onCollapse={toggleSidePanel}
          onNewBrowserTab={() => {
            // The new tab shows in the Browser pane, so the pane comes to the front first.
            openSidePanelPane("browser");
            void openBrowserAddress(BROWSER_NEW_TAB_URL, true);
          }}
        />
      </Show>

      <Show when={launcherShown()}>
        <aside class="browser-panel side-panel-empty" aria-label={t("conversation.sidePanel.label")}>
          <SidePanelLauncher
            available={sidePanelPanes()}
            settingsLabel={channel ? t("channel.settings.title") : undefined}
            onOpen={openSidePanelPane}
          />
        </aside>
      </Show>

      <Show when={activeRightPanel() === "central" && props.agent}>
        {(agent) => (
          <SettingsPanel
            id="agent-central-panel"
            label={t("conversation.sidePanel.pane.central")}
            width={settingsPanelWidth()}
            maxWidth={settingsMaxWidth}
            onResize={setSettingsPanelWidth}
            onResizeEnd={setSettingsPanelWidth}
          >
            <SettingsPanelHeader
              title={t("conversation.sidePanel.pane.central")}
              paneRoot
              closeLabel={t("conversation.sidePanel.close")}
              onClose={() => closeSidePanelPane("central")}
            />
            <SettingsPanelContent>
              <div class="agent-central-content">
                <header class="agent-central-profile">
                  <Button
                    variant="ghost"
                    class="agent-central-avatar-button"
                    aria-label={t("conversation.header.mainChat")}
                    title={t("conversation.header.mainChat")}
                    onClick={openCentralMain}
                  >
                    <AgentAvatar agent={agent()} class="agent-central-avatar" />
                  </Button>
                  <div class="agent-central-identity">
                    <div class="agent-central-name-row">
                      <h2 title={agent().name}>{agent().name}</h2>
                      <Badge
                        variant="outline"
                        role="status"
                        class="agent-central-status"
                        data-state={centralStatus().kind}
                        title={centralStatus().label}
                      >
                        <span class="agent-central-status-dot" aria-hidden="true" />
                        <span>{centralStatus().label}</span>
                      </Badge>
                    </div>
                    <Show when={agent().title}>{(title) => <p>{title()}</p>}</Show>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="agent-central-profile-settings"
                    aria-label={t("conversation.sidePanel.pane.settings")}
                    title={t("conversation.sidePanel.pane.settings")}
                    onClick={() => openSidePanelPane("settings")}
                  >
                    <Settings aria-hidden="true" />
                  </Button>
                </header>
                <section class="agent-central-usage" aria-label={t("conversation.central.overview")}>
                  <header class="agent-central-section-header">
                    <h3>
                      {format.date(new Date(`${centralPeriod().startDate}T12:00:00Z`), {
                        month: "long",
                        year: "numeric",
                        timeZone: "UTC",
                      })}
                    </h3>
                    <div class="agent-central-period-actions">
                      <Select<"current" | "previous">
                        class="agent-central-month-select"
                        options={["current", "previous"]}
                        value={centralMonth()}
                        onChange={(value) => {
                          if (value) setCentralMonth(value);
                        }}
                        itemComponent={(itemProps) => (
                          <SelectItem item={itemProps.item}>
                            {itemProps.item.rawValue === "current"
                              ? t("conversation.central.currentMonth")
                              : t("conversation.central.previousMonth")}
                          </SelectItem>
                        )}
                      >
                        <SelectTrigger size="sm" aria-label={t("usage.panel.period")}>
                          <SelectValue<"current" | "previous">>
                            {(selection) =>
                              selection.selectedOption() === "current"
                                ? t("conversation.central.currentMonth")
                                : t("conversation.central.previousMonth")
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent />
                      </Select>
                      <Show when={panelProps.onOpenUsage}>
                        {(open) => (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("usage.summary")}
                            title={t("usage.summary")}
                            onClick={(event) => open()(event.currentTarget)}
                          >
                            <ExternalLink aria-hidden="true" />
                          </Button>
                        )}
                      </Show>
                    </div>
                  </header>
                  <dl class="agent-central-metrics" aria-busy={centralUsage.phase === "loading" ? "true" : "false"}>
                    <div class="agent-central-metric">
                      <dt>{t("conversation.central.activity")}</dt>
                      <dd class="agent-central-heatmap">
                        <ProfileHeatmap
                          days={centralActivity().days}
                          compact
                          compactRows={sidePanel().maximized || settingsPanelWidth() >= 600 ? 2 : 3}
                          unavailableDates={centralActivity().unavailable}
                          label={t("conversation.central.activity")}
                        />
                      </dd>
                    </div>
                    <div class="agent-central-metric">
                      <dt>{t("conversation.central.tokens")}</dt>
                      <dd
                        title={centralTokens() === null ? t("usage.unavailable") : format.number(centralTokens() ?? 0)}
                      >
                        {centralTokens() === null ? "–" : usageCompact(centralTokens())}
                      </dd>
                    </div>
                    <div class="agent-central-metric">
                      <dt>{t("conversation.central.finishedTasks")}</dt>
                      <dd title={t("conversation.central.finishedHint")}>
                        {centralCompletedCount() === null ? "–" : format.number(centralCompletedCount() ?? 0)}
                      </dd>
                    </div>
                  </dl>
                </section>
                <Show when={props.threads}>
                  {(threads) => (
                    <section class="agent-central-tasks" aria-label={t("conversation.tasks.title")}>
                      <header class="agent-central-section-header">
                        <h3>{t("conversation.tasks.title")}</h3>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!threads().header.canStartNew}
                          onClick={() => threads().header.onNew()}
                        >
                          <Plus aria-hidden="true" />
                          {t("conversation.central.newTask")}
                        </Button>
                      </header>
                      <For each={centralTaskGroups()} keyed={(group) => group.id}>
                        {(group) => (
                          <section
                            class="agent-central-task-group"
                            aria-labelledby={`${centralSectionsId}-${group().id}-heading`}
                          >
                            <h4 id={`${centralSectionsId}-${group().id}-heading`}>
                              <Button
                                variant="ghost"
                                class="agent-central-group-toggle"
                                aria-label={t(group().label)}
                                aria-expanded={collapsedSections[group().id] ? "false" : "true"}
                                aria-controls={`${centralSectionsId}-${group().id}-items`}
                                onClick={() =>
                                  setCentralTaskSectionCollapsed(group().id, !collapsedSections[group().id])
                                }
                              >
                                <ChevronDown class="agent-central-group-chevron" aria-hidden="true" />
                                <span>{t(group().label)}</span>
                                <span class="agent-central-group-count">{format.number(group().tasks.length)}</span>
                              </Button>
                            </h4>
                            <div id={`${centralSectionsId}-${group().id}-items`} hidden={collapsedSections[group().id]}>
                              <Show when={!collapsedSections[group().id]}>
                                <Show
                                  when={group().tasks.length > 0}
                                  fallback={<p>{t("conversation.central.emptySection")}</p>}
                                >
                                  <ul class="agent-central-task-list">
                                    <For each={group().tasks}>
                                      {(task) => (
                                        <li class="agent-central-task-row">
                                          <Show
                                            when={centralTaskUi.renaming === task.id}
                                            fallback={
                                              <>
                                                <Button
                                                  variant="ghost"
                                                  class="sidebar-agent-thread-button agent-central-task-main"
                                                  title={task.title}
                                                  aria-pressed={
                                                    threads().header.activeId === task.id ? "true" : "false"
                                                  }
                                                  data-attention={threadAttention(
                                                    centralTaskThread(task.id)?.status ?? { kind: "idle" },
                                                  )}
                                                  aria-label={`${t("conversation.tasks.page.row", {
                                                    title: task.title,
                                                    agent: agent().name,
                                                    status: agentTaskStatus(task, t, centralTaskWait(task.id)),
                                                  })}${(centralTaskThread(task.id)?.unread ?? 0) > 0 ? `. ${t("sidebar.state.unread", { count: centralTaskThread(task.id)?.unread ?? 0 })}` : ""}`}
                                                  onPointerDown={(event) =>
                                                    startTaskTransfer(
                                                      event,
                                                      threads().header.taskTransfer,
                                                      centralTaskThread(task.id),
                                                    )
                                                  }
                                                  onClick={() => openCentralTask(task)}
                                                >
                                                  <span
                                                    class="sidebar-agent-thread-icon sidebar-agent-task-status"
                                                    data-status={centralTaskThread(task.id)?.status.kind}
                                                    aria-hidden="true"
                                                  >
                                                    <Show
                                                      when={centralTaskWaitReason(task.id)}
                                                      fallback={<TaskMark state={centralTaskMark(task)} />}
                                                    >
                                                      {(reason) => <SidebarWaitIcon reason={reason()} />}
                                                    </Show>
                                                  </span>
                                                  <ThreadTitle class="sidebar-agent-thread-title" title={task.title} />
                                                  <Show when={(centralTaskThread(task.id)?.unread ?? 0) > 0}>
                                                    <span class="sidebar-agent-thread-icon" aria-hidden="true">
                                                      <span class="agent-threads-state agent-threads-unread" />
                                                    </span>
                                                  </Show>
                                                  <time
                                                    class="agent-central-task-date"
                                                    datetime={task.updatedAt}
                                                    title={format.date(new Date(task.updatedAt), {
                                                      dateStyle: "medium",
                                                      timeStyle: "short",
                                                    })}
                                                  >
                                                    {sidebarMessageTime(task.updatedAt, format)}
                                                  </time>
                                                </Button>
                                                <DropdownMenu.Root placement="bottom-end">
                                                  <DropdownMenu.Trigger
                                                    class={buttonVariants({
                                                      variant: "ghost",
                                                      size: "icon-sm",
                                                      class: "agent-central-task-actions",
                                                    })}
                                                    aria-label={t("conversation.central.taskActions", {
                                                      title: task.title,
                                                    })}
                                                  >
                                                    <Ellipsis aria-hidden="true" />
                                                  </DropdownMenu.Trigger>
                                                  <DropdownMenu.Portal>
                                                    <DropdownMenu.Content
                                                      class="agent-threads-tab-menu"
                                                      aria-label={t("conversation.threads.actions")}
                                                    >
                                                      <Show when={task.state !== "closed"}>
                                                        <DropdownMenu.Item onSelect={() => openCentralTask(task)}>
                                                          <MessageSquare
                                                            class="agent-context-icon size-4"
                                                            aria-hidden="true"
                                                          />
                                                          <span>{t("common.open")}</span>
                                                        </DropdownMenu.Item>
                                                        <Show when={threads().header.onRename}>
                                                          <DropdownMenu.Item
                                                            onSelectAfterClose={() => startCentralRename(task)}
                                                          >
                                                            <PencilLine
                                                              class="agent-context-icon size-4"
                                                              aria-hidden="true"
                                                            />
                                                            <span>{t("common.rename")}</span>
                                                          </DropdownMenu.Item>
                                                        </Show>
                                                        <DropdownMenu.Separator />
                                                        <DropdownMenu.Item
                                                          disabled={task.state === "running"}
                                                          onSelect={() => threads().header.onArchive(task.id)}
                                                        >
                                                          <Archive
                                                            class="agent-context-icon size-4"
                                                            aria-hidden="true"
                                                          />
                                                          <span>{t("conversation.threads.archive")}</span>
                                                        </DropdownMenu.Item>
                                                      </Show>
                                                      <Show when={task.state === "closed"}>
                                                        <DropdownMenu.Item onSelect={() => openCentralTask(task)}>
                                                          <ArchiveRestore
                                                            class="agent-context-icon size-4"
                                                            aria-hidden="true"
                                                          />
                                                          <span>{t("conversation.threads.restore")}</span>
                                                        </DropdownMenu.Item>
                                                      </Show>
                                                      <Show when={threads().header.onDelete}>
                                                        <DropdownMenu.Item
                                                          class="ui-action-menu-danger"
                                                          disabled={isAgentTaskActive(task)}
                                                          onSelect={() => threads().header.onDelete?.(task.id)}
                                                        >
                                                          <Trash2
                                                            class="agent-context-icon size-4"
                                                            aria-hidden="true"
                                                          />
                                                          <span>{t("common.delete")}</span>
                                                        </DropdownMenu.Item>
                                                      </Show>
                                                    </DropdownMenu.Content>
                                                  </DropdownMenu.Portal>
                                                </DropdownMenu.Root>
                                              </>
                                            }
                                          >
                                            <Input
                                              size="sm"
                                              value={centralTaskUi.name}
                                              aria-label={t("conversation.threads.name")}
                                              maxlength={INPUT_LIMITS.agentTaskTitle}
                                              ref={(field: HTMLInputElement) =>
                                                requestAnimationFrame(() => {
                                                  field.focus();
                                                  field.select();
                                                })
                                              }
                                              onInput={(event) =>
                                                setCentralTaskUi((state) => {
                                                  state.name = event.currentTarget.value;
                                                })
                                              }
                                              onKeyDown={(event) => {
                                                if (event.key === "Enter") {
                                                  event.preventDefault();
                                                  finishCentralRename(event.currentTarget.value);
                                                } else if (event.key === "Escape") {
                                                  event.preventDefault();
                                                  event.stopPropagation();
                                                  finishCentralRename(null);
                                                }
                                              }}
                                              onBlur={(event) => finishCentralRename(event.currentTarget.value)}
                                            />
                                          </Show>
                                        </li>
                                      )}
                                    </For>
                                  </ul>
                                </Show>
                              </Show>
                            </div>
                          </section>
                        )}
                      </For>
                    </section>
                  )}
                </Show>
              </div>
            </SettingsPanelContent>
          </SettingsPanel>
        )}
      </Show>

      <Show when={filePreviewOpen() && sidebarFilePreview()}>
        {(file) => {
          const attached = () => {
            const source = file().source;
            return source.kind === "attachment" ? source.attachment : null;
          };
          return (
            <Loading>
              <FilePreviewPanel
                allowExternalOpen={!props.runtime}
                macWindowControls={props.platform === "darwin"}
                preview={file().preview}
                directory={file().directory ?? null}
                agents={props.agents}
                defaultWidth={() =>
                  (conversationPanelElement()?.clientWidth || window.innerWidth) * BROWSER_PANEL_DEFAULT_RATIO
                }
                maxWidth={() =>
                  Math.min(
                    BROWSER_PANEL_MAX,
                    Math.max(
                      BROWSER_PANEL_MIN,
                      (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
                    ),
                  )
                }
                width={settingsPanelWidth()}
                onWidthChange={setBrowserPanelWidth}
                onOpenLink={(url) => void openExternalMessageUrl(url)}
                onOpenSharedFile={(path) => openSharedFile(path, "here")}
                onOpenWorkspaceFile={previewWorkspaceAgentId() ? openWorkspaceFolderEntry : undefined}
                onOpenWorkspaceFolder={openWorkspaceFolder}
                onBack={sidebarFileBack() === null ? undefined : openSidebarFileBack}
                sourceUrl={attached()?.previewUrl ?? null}
                pageUrl={htmlAttachmentPageUrl(attached()) ?? file().preview?.pageUrl}
                pageHtml={props.runtime?.visualPage ? htmlAttachmentPageHtml(attached(), file().preview) : undefined}
                fileKey={previewFileKey()}
                selectionQuoteId={previewQuoteId()}
                // A page quotes as a passage of its file, so the quote opens the page again.
                onPageQuote={(text) => {
                  const quoteId = previewQuoteId();
                  if (quoteId) quoteSelection(quoteId, text);
                }}
                // The page state goes with the message that holds the page, as in the chat.
                onPageContext={(text) => {
                  const id = attached()?.id;
                  const message = id && props.messages.find((item) => item.attachments?.some((file) => file.id === id));
                  if (message) setPageContext(message, text);
                }}
                onPageMessage={addPageText}
                isPageAppShortcut={isChatVisualAppShortcut}
                quoteShortcut={deviceQuoteShortcut(props.platform)}
                onOpenExternally={openSidebarFileExternally}
                onDownload={downloadSidebarFile}
                /* A browser cannot show a file in the file manager. */
                onReveal={props.runtime ? undefined : revealSidebarFile}
                onClose={closeShownSidePanelFile}
              />
            </Loading>
          );
        }}
      </Show>

      <Show when={filesOpen() && !props.runtime && serverHasStorage(props.server) && props.server}>
        {(server) => (
          <Show when={props.agent?.threadId}>
            {(threadId) => (
              <Loading>
                <ChatFilesPanel
                  serverId={server().id}
                  conversationId={threadId()}
                  conversationTitle={props.agent?.name ?? "this chat"}
                  canManage={canManageStorage(server())}
                  onClose={() => closeSidePanelPane("files")}
                  onPreviewFile={(file) => void previewAttachment(file)}
                  onShowMessage={(messageId) => void props.onOpenSearchMessage?.(messageId)}
                />
              </Loading>
            )}
          </Show>
        )}
      </Show>

      <Show when={activeRightPanel() === "question" && props.agent}>
        {(agent) => (
          <SideQuestionPanel
            agent={agent()}
            agents={props.agents}
            exchanges={sideQuestion().exchanges}
            skills={installedSkills()}
            skillsLoadFailed={installedSkillsLoadFailed()}
            mcpServers={mcpServers()}
            error={sideQuestion().error}
            draft={sideQuestion().draft}
            focusRequest={sideQuestion().focusRequest}
            onDraftChange={setSideQuestionDraft}
            onAsk={askSideQuestion}
            onClosePanel={() => closeSidePanelPane("question")}
            onOpenLink={(url) => void openExternalMessageUrl(url)}
            macWindowControls={props.platform === "darwin"}
          />
        )}
      </Show>

      {/* Keyed, so another agent or server gets its own conversation; closing the Voice tab ends it. */}
      <Show
        when={
          activeRightPanel() === "voice" &&
          voiceConversationAvailable() &&
          props.agent &&
          `${props.server?.id ?? "local"}:${props.agent.id}`
        }
        keyed
      >
        <VoiceConversationPane />
      </Show>

      {/* Keyed, so each side thread gets its own messages and read state. */}
      <Show when={shownThread()} keyed>
        {(threadId) => <ConversationSideThread threadId={threadId} />}
      </Show>

      <Show when={activeRightPanel() === "subagent"}>
        <SubagentPanel
          subagent={panelSubagent()}
          agentName={props.agent?.name ?? ""}
          onClosePanel={() => closeSidePanelPane("subagent")}
        />
      </Show>

      <Show when={browserSidebarOpen() || browserExpandedOpen()}>
        <BrowserPreviewSidebar
          tabs={browserTabs()}
          busyTabIds={busyBrowserTabIds()}
          hidden={browserExpandedOpen()}
          suspended={props.browserVisibilitySuspended || props.globalOverlayOpen || props.remoteDesktopVisible}
          contextKey={`${props.server?.id ?? "local"}:${props.agent?.id ?? ""}`}
          defaultWidth={() => 320}
          maxWidth={() =>
            Math.min(
              BROWSER_PANEL_MAX,
              Math.max(
                BROWSER_PANEL_MIN,
                (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
              ),
            )
          }
          width={settingsPanelWidth()}
          onWidthChange={setBrowserPanelWidth}
          capturePreview={props.runtime?.browser.capturePreview}
          onOpenTab={(tabId, trigger) => {
            browserPreviewTrigger = trigger;
            if (activeBrowserTab()?.id !== tabId) activateBrowserTab(tabId);
            setActiveRightPanel("browser-expanded");
          }}
          onCloseTab={(tabId) => void closeBrowserTab(tabId)}
          onNewTab={() => void openBrowserAddress(BROWSER_NEW_TAB_URL, true)}
        />
      </Show>

      <Show when={browserSidebarOpen() || browserExpandedOpen()}>
        <Portal>
          <div class="ui-dialog-overlay browser-expanded-backdrop" hidden={!browserExpandedOpen()} aria-hidden="true" />
          <BrowserFullViewAdapter />
        </Portal>
      </Show>

      {channel ? (
        <Show when={settingsOpen()}>
          <channel.SettingsPane
            width={settingsPanelWidth()}
            maxWidth={settingsMaxWidth}
            onWidthChange={setSettingsPanelWidth}
            onClose={() => closeSidePanelPane("settings")}
          />
        </Show>
      ) : null}
      <Show when={settingsOpen() && props.agent}>
        {(agent) => (
          <Loading>
            <AgentSettingsPanel
              remoteClient={Boolean(props.runtime)}
              localHost={props.server?.kind === "local"}
              routineRunPlace={
                props.server?.kind === "remote" && serverSupportsCapability(props.server, "routine-run-place-v1")
              }
              folders={folderCalls()}
              instructionsFile={instructionsCalls()}
              sessionSettingsEditable={serverCanAdminister(props.server, "agent-session-settings-v1")}
              adminCalls={props.runtime?.admin}
              skillsMarketplaceOpen={props.skillsMarketplaceOpen}
              workspaceCovered={props.workspaceCovered}
              onAddFromMarketplace={
                serverCanAdminister(props.server, "skills-admin-v1") ? props.onOpenMarketplace : undefined
              }
              skillsMode={agentSkillsMode(props.server, props.runtime)}
              skillsServerId={props.server?.id}
              previewWorkspaceFile={(path) =>
                conversationRuntime(props).agent.previewWorkspaceFile({ agentId: agent().id, path })
              }
              tablesVisible={
                (!props.runtime || props.runtime.admin !== undefined) &&
                serverCanAdminister(props.server, "shared-tables-v1")
              }
              autoApprove={props.agentAutoApproves}
              onUpdatePermissions={props.onUpdateAgentPermissions}
              computerUseEditable={props.server?.kind === "local" || props.remoteComputerUseLoaded === true}
              automationEditable={
                props.server?.kind === "local" ||
                (serverCanAdminister(props.server, "agent-host-settings-v1") && agent().allowAutomation !== undefined)
              }
              busyMessageModeEditable={props.server?.kind === "local" || props.remoteBusyMessageModeLoaded === true}
              busyMessageDefaultIsHost={props.server?.kind === "remote"}
              newChatEditable={props.server?.kind === "local" || props.remoteNewChatLoaded === true}
              quickAcknowledgementEditable={props.server?.kind === "local" || props.remotePlanCardLoaded === true}
              // The same Fast state and switch as the model picker of the chat header.
              fastMode={fastMode()}
              onFastModeChange={fastModeChange()}
              taskLimitEditable={props.server?.kind === "local" || props.remoteTaskLimitLoaded === true}
              taskLimitMax={serverSupportsCapability(props.server, "agent-task-limit-v2") ? 10 : 4}
              backupModelsEditable={props.server?.kind === "local" || props.remoteBackupModelsLoaded === true}
              usageLimited={props.usageLimited}
              providerFailed={props.providerFailed}
              defaultBusyMessageMode={props.defaultBusyMessageMode}
              agentDefaults={localAgentDefaults()}
              memoryLimit={props.server?.kind === "local" ? props.agentMemoryLimit : undefined}
              agents={props.agents}
              onStartNewChat={props.onClearAgentContext}
              onDeleteHistory={props.onDeleteAgentHistory}
              onCreateSkill={
                serverCanAdminister(props.server, "skills-admin-v1") &&
                agentReady() &&
                !controller.submitting() &&
                controller.voicePhase() === "idle" &&
                !controller.editingDeliveryId()
                  ? () => {
                      if (!props.agent || !props.server) return;
                      controller.startSkillCreation({ serverId: props.server.id, agentId: props.agent.id });
                      setActiveRightPanel("none");
                    }
                  : undefined
              }
              onTrySkill={
                serverCanAdminister(props.server, "skills-admin-v1") &&
                agentReady() &&
                !controller.submitting() &&
                controller.voicePhase() === "idle" &&
                !controller.editingDeliveryId()
                  ? (skill) => {
                      if (!props.agent || !props.server) return;
                      controller.appendSkillExample({ serverId: props.server.id, agentId: props.agent.id }, skill);
                      setActiveRightPanel("none");
                    }
                  : undefined
              }
              onOpenUsage={panelProps.onOpenUsage}
              onPublish={canPublish() ? () => publishAgent.open(agent().id) : undefined}
              agent={agent()}
              runtimeSettings={{
                provider: settingsProvider(),
                model: settingsModel(),
                reasoningEffort: settingsReasoning(),
              }}
              agentStatus={props.agentStatus}
              providerRuntimeStatuses={props.providerRuntimeStatuses}
              customProviders={props.customProviders}
              customAgents={props.customAgents}
              onDownloadProvider={props.onDownloadProvider}
              onCancelProviderDownload={props.onCancelProviderDownload}
              onConnectProvider={props.onConnectProvider}
              canConnectProvider={props.canConnectProvider}
              onManageProviders={props.onManageProviders}
              browserProfileCalls={
                serverCanAdminister(props.server, BROWSER_PROFILES_CAPABILITY) ? browserProfileCalls() : undefined
              }
              onManageBrowserProfiles={props.onManageBrowserProfiles}
              notificationLevelCalls={notificationLevelCalls()}
              serverNotificationLevel={props.server?.notificationLevel}
              onOpenNotificationSettings={
                props.onOpenNotificationSettings && props.server ? openNotificationSettings : undefined
              }
              modelOptions={props.modelOptions}
              working={agentActivity() === "Working"}
              width={settingsPanelWidth()}
              maxWidth={settingsMaxWidth}
              onClose={() => closeSidePanelPane("settings")}
              onWidthChange={setSettingsPanelWidth}
              onUpdateAgent={props.onUpdateAgent}
              onUpdateRuntimeSettings={updateRuntimeSettings}
              onSetAgentAvatar={props.onSetAgentAvatar}
              skillSelectionRequest={skillSettingsRequest()?.agentId === agent().id ? skillSettingsRequest() : null}
              instructionsRequest={
                instructionsSettingsRequest()?.agentId === agent().id ? instructionsSettingsRequest() : null
              }
              routineSelectionRequest={
                routineSettingsRequest()?.agentId === agent().id ? routineSettingsRequest() : null
              }
              onRoutineSelectionRequestHandled={handleRoutineSettingsRequest}
              onOpenRoutineRun={props.onOpenSearchMessage ? openRoutineRunMessage : undefined}
              onOpenRoutineThread={props.threads ? openRoutineThread : undefined}
              files={agentFiles(props.server, agent().id)}
              eventRoutines={desktopChatEventRoutinesApi(props.server, props.runtime)}
              routines={props.runtime?.routines}
            />
          </Loading>
        )}
      </Show>

      {publishAgent.dialog()}
      {/* A sign-in link of the host's agent, when this computer cannot take its callback: the user pastes
          the address that the browser shows. */}
      <Show when={messageLinkRelay()} keyed>
        {(relay) => (
          <McpSignInRelayDialog
            name={relay.page.authorizeHost}
            hostName={props.server?.name ?? ""}
            page={relay.page}
            onOpen={openMessageLinkRelay}
            onPaste={pasteMessageLinkRelay}
            onCancel={cancelMessageLinkRelay}
          />
        )}
      </Show>
    </>
  );
}

const AgentSettingsPanel = lazy(loadAgentSettingsPanel);
const BrowserFullViewAdapter = lazy(() => import("./BrowserFullViewAdapter"));
const FilePreviewPanel = lazy(() => import("./FilePreviewPanel"));
const ChatFilesPanel = lazy(() => import("../files/ChatFilesPanel"));

const BrowserPreviewSidebar = lazy(() => import("./BrowserPreviewSidebar"));
