# Side panel

## Side panel panes

The side panel is on the right side of a chat. Each open pane has a tab at the top of the panel.
File tabs and side threads also have tabs there, but they have their own models: `SidePanelState.files`
in `panels-store.ts` and the thread list of the agent. The pane registry does not include them.

This is an internal extension point for built-in features. It is not a plugin API.

### Where each part is

| Part | Owner |
| --- | --- |
| Pane id, label key, and icon | `SIDE_PANEL_PANES` in `packages/ui/src/features/conversation/SidePanel.tsx` |
| Pane type and id check | `SidePanelPane` and `isSidePanelPane`, from the same record |
| Panel mode of a pane | The pane id. `RightPanelMode` in `conversation-types.ts` includes `SidePanelPane` |
| Open tabs, selected tab, maximize | `SidePanelState` in `stores/panels-store.ts` |
| Open, close, and the tab that shows after a close | `openSidePanelPane`, `closeSidePanelPane`, and `showSidePanelInPlaceOf` in `conversation-scope.ts` |
| Work of a pane when it opens or closes | `sidePanelPaneActions` in `conversation-scope.ts` |
| Availability | `sidePanelPanes` in `ConversationPanels.tsx`, and the entry point of the feature |
| Content | The feature component, shown from `ConversationPanels.tsx` when `activeRightPanel()` is the pane id |

The tabs, the Add menu, and the launcher read the label and the icon from `SIDE_PANEL_PANES`. The
panel store finds the pane of a panel mode with `isSidePanelPane`. Thus a pane needs no separate
mode map.

### Add a pane

1. Add a label key `conversation.sidePanel.pane.<id>` to each catalog in
   `packages/i18n/src/messages/*/conversation.ts`. Read [docs/i18n.md](../i18n.md) first.
2. Add the pane to `SIDE_PANEL_PANES` with its label key and an icon from `@openbot/ui`. The
   order of the record is the order of the launcher and of the Add menu.
3. Show the content in `ConversationPanels.tsx` when `activeRightPanel()` is the pane id. Keep the
   content component, its store, and its calls in the owning feature. Give a shared component typed
   props, as [packages/ui/AGENTS.md](../../packages/ui/AGENTS.md) says. The content calls
   `closeSidePanelPane(<id>)` to close its own tab.
4. Control availability:
   - To list the pane in the launcher and the Add menu, add a rule to `sidePanelPanes`. The rule
     must be true only when the content can show, for example only when an agent is open.
   - A pane that opens from one place only, such as a side question or a subagent, is not in
     `sidePanelPanes`. Its entry point checks availability before it calls `openSidePanelPane`.
5. Add an entry to `sidePanelPaneActions` only when the pane must do more than show its mode:
   - `open` runs in place of the mode change. The Browser pane uses it to start a tab.
   - `release` runs before the tab closes. The question pane uses it to delete its question.
6. Release long-lived resources in the owning feature. A store can watch
   `SidePanelState.panes` and stop when its pane leaves the list, as `createVoiceSessions` does for a
   voice conversation. A component releases its own resources in `onCleanup`.

### Close behavior

`closeSidePanelPane` runs the `release` action, removes the tab, and keeps the order of the other
tabs. When the closed pane showed, the panel shows, in this order:

1. The pane next to the closed tab.
2. The first side thread.
3. The last file tab.
4. The pane list, when no tab stays.

The panel keeps its tabs while it is collapsed. Each agent and each channel has its own tabs.

### Verification

A change to the registry or to pane behavior must keep the behavior of the existing panes. Check
these in the real app:

- Open and select each pane from the launcher, the Add menu, and its own entry point.
- Close the selected tab and a tab that is not selected. The next tab must show.
- Collapse and open the panel again. The same tab must show.
- Maximize and restore the panel.
- File tabs and side threads beside the panes.
- Switch to another agent or server and back.
- The question pane deletes its question on close, and the voice conversation stops on close.

`scripts/side-panel-panes-e2e.ts` checks the launcher and Add menu order, selection, close, collapse,
maximize, an agent change, and the side question release in the `App/Playground` story.
`scripts/web-side-panel-e2e.ts` compares the web and desktop panels in Storybook.
`scripts/voice-pane-e2e.ts` checks the Voice pane.

Agent chats open the Central pane by default. Central and Agent settings are navigation preferences
shared by agents of the same server and saved locally; collapsing the panel also keeps it closed on
the next agent. Channels retain their own behavior. These preferences never copy settings drafts,
files, browser sessions, voice sessions, or side threads between agents. With Central preferred, an
agent's existing contextual pane can still be restored. An explicit settings request takes precedence.
Files and file previews still close on an agent change (`resetPanelsForAgent` in
`conversation-scope.ts`); their tabs stay.

The Central composes the existing profile avatar and `ProfileHeatmap`, with the agent-scoped host
analytics report. Three adjacent columns show a compact activity grid, tokens and finished
tasks, using the label/value typography of Usage totals. Each has a subtle rounded border,
no background and vertically centered content. The month toolbar holds the period selector
and Usage shortcut; there is no date-range footer.
The selector offers the current calendar month (through today) and the previous full calendar month,
in the analytics time zone. `ProfileHeatmap` has an optional compact monthly layout with two rows in
a wide panel and three in a narrow panel. All calendar days of the selected month are represented;
future or unknown days remain neutral with unavailable usage. Padding completes only the final row
without adding dates. Other profile heatmaps retain their year layout.
Tokens use `analyticsTokens` from the selected period's agent-scoped report. Task completions come
from the same report's optional `completedTasks` field. The host groups persisted `projection_turns`
by retained side thread and selects its first successful `completed_at` before filtering the requested
calendar dates in the analytics time zone. Each task counts once, including archived tasks and tasks
beyond the visible list limit. Rename, restore, archive and subsequent turns do not move that first
completion. Failed/interrupted turns, branches without an execution and records without a completion
timestamp add no guessed date; a missing timestamp does not invalidate other known completions.
No message history is fetched for this metric. Task-change and turn-completion events refresh it.
Remote hosts with `host-task-completions-v1` serve the extended report at
`GET /v1/analytics/task-completions` with the same scoped date query. Released host-analytics routes
and codecs remain unchanged. Older hosts leave the field absent, so only this metric is unavailable.
The new capability is protocol-9-only to preserve the older capability list bounds.
Cells with missing usage stay neutral and report Unavailable in their tooltip. The Central has no inline completeness notices. The task sections reuse the thread
controller's open, rename, archive, restore and reversible delete operations. Rows reuse the sidebar's
`TaskMark`, wait icons, `ThreadTitle`, typography and date formatter in one line: status, title,
last update and menu. Central uses the same `ThreadItem.unread` and blue unread dot as the sidebar,
placed before the update time so the date and menu stay aligned. The accessible row label includes
the unread count; opening the main task chat uses the existing read-cursor flow. A row and its Open action move the task to the main chat, preserving Central;
a task already shown on the side is moved instead of duplicated. Menus reuse the standard action
menu surface and sidebar icons: Open, Rename, Archive and Delete when supported. Running tasks
cannot be archived or deleted; queued tasks cannot be deleted. Archived rows restore before opening.
Inline rename captures the owner agent and
cancels when navigating to another agent; Enter saves and Escape cancels.

### Shared dock width

The conversation controller owns one width for every dock tab, including task chats, Central,
settings, browser previews and files. `openbot:side-panel-width` persists the chosen width; the
previous settings width supplies the initial fallback. Both layout width variables read the same
signal. The dock reuses `PanelResizer` outside pane lifetimes, so tab changes cannot remove its
handle or reset its width. Nested panel handles stay hidden in the dock; standalone consumers
retain their previous width behavior. Maximizing hides the handle and restoring keeps the chosen
width. Resizing the host clamps the dock to the available space while preserving the chat minimum.

### Agent Central identity and task disclosures

The Central header keeps the existing avatar and standard settings button, with a stronger name/title
hierarchy. Agent activity, task activity, waits and host readiness determine the status text; the
status moves below the identity in a narrow panel. The presentation stays within the existing tokens.

Tasks are grouped, in order, into Completed, In progress and Archived. Completed holds open, inactive
tasks whose last outcome is completed; the other open tasks (including new, queued, waiting or failed
tasks) remain in In progress, with their existing status glyphs. Archived follows the host's archived
thread list. Row actions and main-column navigation remain the existing operations.

Each section has an independent accessible disclosure, built with the existing Button and native
expanded/controls semantics. There are no Open/Archived filter tabs or task-section divider.
`central-task-sections.ts` owns one device preference under `openbot:central-task-sections`, shared
across all agents and hosts. Completed and In progress start expanded; Archived starts collapsed.
A saved user choice overrides those defaults. The module shares reactive state within a page and
listens for storage events across chat windows, disposing the listener during HMR. Malformed or
unavailable storage preserves safe defaults; a failed write still retains the choice in page state.

Central disclosure headers and task rows use a hover-only background. Expanded/collapsed state,
selected-task state and focus-within do not keep a fill behind the item; shared keyboard focus
indicators remain visible. These overrides are scoped to Central, preserving sidebar selection.

### Conversa principal pelo avatar da Central

A foto no cabeçalho da Central é um botão acessível que abre `MAIN_THREAD_ID` na coluna principal.
A antiga linha fixa e seu menu foram removidos da lista de tarefas. O clique reutiliza a navegação
existente e reconhece a leitura quando o histórico da conversa já está carregado. Não cria tarefas,
não muda os contadores e mantém os rascunhos de cada conversa.

O editor compartilhado recebe uma chave `focusOnOpen` para focar uma vez ao abrir/trocar conversa.
A chave inclui servidor/agente no principal e a identidade da tarefa no `AgentThreadView`.
Atualizações de mensagens ou da fila não renovam o pedido. O foco ocorre após a montagem, com
`preventScroll`, e respeita modais, menus, seleção de texto, campos em edição e layout de toque.
A navegação pode transferir o foco do compositor anterior que já está oculto/inert, preservando
outros compositores que continuam visíveis. Abrir configurações mantém o foco nesse fluxo.
