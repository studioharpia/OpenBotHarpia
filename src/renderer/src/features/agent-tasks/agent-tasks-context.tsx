import { AGENT_TASK_TRANSFER_CAPABILITY } from "@openbot/contracts/team-protocol/agent-task-transfer-v1";
import { AGENT_THREAD_MESSAGE_ACTIONS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-thread-message-actions-v1";
import { AGENT_THREAD_PAGES_CAPABILITY } from "@openbot/contracts/team-protocol/agent-thread-pages-v1";
import { MESSAGE_DELETE_CAPABILITY } from "@openbot/contracts/team-protocol/message-delete-v1";
import { MESSAGE_DELIVERY_CAPABILITY } from "@openbot/contracts/team-protocol/message-delivery-v1";
import { createSimpleContext } from "../../simple-context";
import { useAgents } from "../agents/agents-context";
import { useServers } from "../servers/servers-context";
import { agentTasksPort } from "./agent-tasks-port";
import { createAgentTasks } from "./agent-tasks-state";

/**
 * The side threads of the active server. A joined server shows them when it has the `agent-tasks-v1`
 * routes, renames and deletes them only with `agent-threads-v1`, and branches only with
 * `agent-thread-branches-v1`.
 */
const AgentTasks = createSimpleContext({
  name: "AgentTasks",
  init: () => {
    const { activeServer, activeServerSupportsCapability } = useServers();
    const { activeAgentId, agentStatus } = useAgents();
    const local = () => {
      const server = activeServer();
      return !server || server.kind === "local";
    };
    return createAgentTasks({
      failureReadScope: activeServer()?.id ?? "local",
      serverId: () => activeServer()?.id ?? "local",
      port: () => agentTasksPort(activeServer()?.id),
      activeAgentId,
      local,
      available: () => local() || activeServerSupportsCapability("agent-tasks-v1"),
      transferable: () => local() || activeServerSupportsCapability(AGENT_TASK_TRANSFER_CAPABILITY),
      editable: () => local() || activeServerSupportsCapability("agent-threads-v1"),
      readable: () => local() || activeServerSupportsCapability("agent-thread-reads-v1"),
      messageDelivery: () => local() || activeServerSupportsCapability(MESSAGE_DELIVERY_CAPABILITY),
      messageActions: () => local() || activeServerSupportsCapability(AGENT_THREAD_MESSAGE_ACTIONS_CAPABILITY),
      branchable: () => local() || activeServerSupportsCapability("agent-thread-branches-v1"),
      filesAccepted: () => local() || activeServerSupportsCapability("agent-thread-files-v1"),
      repliable: () => local() || activeServerSupportsCapability("agent-thread-replies-v1"),
      messageDeletable: () => local() || activeServerSupportsCapability(MESSAGE_DELETE_CAPABILITY),
      pageable: () => local() || activeServerSupportsCapability(AGENT_THREAD_PAGES_CAPABILITY),
      // A server switch or reconnect reads the lists again, and so does a start of the agent.
      reloadKey: () => {
        const server = activeServer();
        return `${server?.id ?? ""}:${server?.state ?? ""}:${agentStatus().phase}`;
      },
    });
  },
});

export const AgentTasksProvider = AgentTasks.provider;
export const useAgentTasks = AgentTasks.use;
