import { taskApproval } from "@openbot/team-client/agent-tasks";
import { computeAgentAvatarMoods } from "@openbot/ui/features/agents/agent-avatar-mood";
import { computeSidebarAgentStates } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import type { SidebarAgentState } from "@openbot/ui/features/sidebar/sidebar-types";
import { createMemo } from "solid-js";
import { useTurns } from "../../turns";
import { useAgentTasks } from "../agent-tasks/agent-tasks-context";
import { useConversation } from "../conversation/conversation-context";
import { attentionByAgent, attentionKey } from "./agent-runtime-snapshot";
import { agentThreadAttention } from "./agent-thread-attention";
import { useAgents } from "./agents-context";

/**
 * What each agent of the active server does now: its working turn, the badge state that the sidebar
 * and the agent dock show, and the face of its avatar. Both surfaces read it, so they always agree.
 */
export function createAgentActivity(options?: { includeTasks: () => boolean }) {
  const { agentList } = useAgents();
  const { activeTurns, subagentTurns, queues, failedTurns, usageLimits, pendingPrompts, pendingApprovals, approvals } =
    useTurns();
  const { agentUnreadReplies, unreadReplies, recentReplies } = useConversation();
  const agentTasks = useAgentTasks();

  /* The turn events of a side thread reach only its thread list, so an agent that works in a side
   * thread is found there. A subagent that runs on after its turn keeps its agent at work. */
  const workingTurns = createMemo(() => {
    const turns = { ...activeTurns() };
    const subagents = subagentTurns();
    for (const agent of agentList()) {
      const running = agentTasks.snapshot(agent.id)?.tasks.find((task) => task.state === "running");
      if (running && !turns[agent.id]) turns[agent.id] = running.activeTurnId ?? running.id;
      const subagentTurn = subagents[agent.id];
      if (subagentTurn && !turns[agent.id]) turns[agent.id] = subagentTurn;
    }
    return turns;
  });

  /* Sidebar tasks keep their own indicators. When tasks live in the topbar, the parent
   * summarizes their pending work too; channel threads stay outside this aggregation. */
  const agentStates = createMemo(() => {
    const includeTasks = options?.includeTasks() ?? true;
    const states = computeSidebarAgentStates({
      agentIds: agentList().map((agent) => agent.id),
      activeTurns: includeTasks ? workingTurns() : activeTurns(),
      queues: queues(),
      unreadReplies: includeTasks ? agentUnreadReplies() : unreadReplies(),
      recentReplies: recentReplies(),
      ...agentThreadAttention({ agents: agentList(), pendingPrompts: pendingPrompts(), approvals: approvals() }),
      failedTurns: failedTurns(),
      usageLimits: usageLimits(),
    });
    if (includeTasks) {
      for (const agent of agentList()) {
        const main = states[agent.id];
        if (
          main?.kind === "waiting" ||
          main?.kind === "limited" ||
          (main?.kind === "routine" && main.phase === "failed")
        )
          continue;
        const tasks = (agentTasks.snapshot(agent.id)?.tasks ?? []).filter((task) => task.state !== "closed");
        let waiting: Extract<SidebarAgentState, { kind: "waiting" }> | undefined;
        for (const task of tasks) {
          if (task.state !== "running") continue;
          const prompt = pendingPrompts()[attentionKey(agent.id, task.threadId)];
          const reason = taskApproval(task, approvals())
            ? "approval"
            : prompt?.type === "prompt"
              ? "question"
              : prompt?.type === "browser-takeover-requested"
                ? "takeover"
                : undefined;
          if (reason) {
            waiting = { kind: "waiting", reason, detail: null };
            break;
          }
        }
        const failed = tasks.filter(
          (task) => task.state === "idle" && task.outcome === "failed" && !agentTasks.failureRead(task),
        );
        if (waiting) states[agent.id] = waiting;
        else if (failed.length > 0)
          states[agent.id] = { kind: "routine", phase: "failed", count: failed.length, task: true };
      }
    }
    return states;
  });

  /* The badge says what an agent is doing; the face says how it is going. `isAgentWorking` is
   * shared, and a routine mark only replaces the badge for that same agent. */
  const agentMoods = createMemo(() =>
    computeAgentAvatarMoods({
      agentIds: agentList().map((agent) => agent.id),
      activeTurns: workingTurns(),
      queues: queues(),
      failedTurns: failedTurns(),
      pendingPrompts: attentionByAgent(pendingPrompts(), agentList()),
      pendingApprovals: pendingApprovals(),
      recentReplies: recentReplies(),
    }),
  );

  return { workingTurns, agentStates, agentMoods };
}
