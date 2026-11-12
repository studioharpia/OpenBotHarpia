// Controlled native Codex process for service and real-app queue checks. No provider/network calls.
export const FAKE_TURN_INPUT_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const log = (entry) => {
  if (!["turn/start", "turn/steer", "turn/interrupt", "thread/start"].includes(entry.method)) return;
  const p = entry.params || {};
  fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify({ method: entry.method, params: { threadId: p.threadId, expectedTurnId: p.expectedTurnId, clientUserMessageId: p.clientUserMessageId, input: p.input } }) + "\\n");
};
const control = () => JSON.parse(fs.readFileSync(process.env.OPENBOT_FAKE_CODEX_CONTROL, "utf8"));
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
const held = new Map();
let steers = 0;
fs.watch(process.env.OPENBOT_FAKE_CODEX_CONTROL, { persistent: false }, () => {
  let settings;
  try { settings = control(); } catch { return; }
  if (!settings.releaseAll) return;
  for (const [threadId, turnId] of held) {
    held.delete(threadId);
    write({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "final-" + turnId, text: "Original turn finished.", phase: "final_answer" } } });
    write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  }
});
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      write({ method: "thread/tokenUsage/updated", params: { threadId: params.threadId, turnId, tokenUsage: { total: { totalTokens: 1000 }, last: { totalTokens: 1000 }, modelContextWindow: 100000 } } });
      const inputText = (params.input ?? []).map(item => item.text ?? "").join(" ");
      if (inputText.includes("HOLD-STEER")) {
        held.set(params.threadId, turnId);
        if (inputText.includes("ASK-QUESTION")) write({ id: "question-" + turnId, method: "item/tool/requestUserInput", params: { threadId: params.threadId, turnId, itemId: "question-item", questions: [{ id: "continue", header: "Continue", question: "Keep the current request?", options: [{ label: "Yes", description: "Continue." }, { label: "No", description: "Wait." }] }] } });
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item: { type: "agentMessage", id: "before-" + turnId, text: "Original work in progress.", phase: "commentary" } } });
        return;
      }
      setTimeout(() => {
        const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, control().turnMs);
      return;
    }
    case "turn/steer": {
      const turnId = held.get(params.threadId);
      if (!turnId || params.expectedTurnId !== turnId) return write({ id: message.id, error: { code: -1, message: "Wrong turn." } });
      write({ id: message.id, result: { turnId } });
      const text = (params.input ?? []).map(item => item.text ?? "").join(" ");
      const item = { type: "agentMessage", id: "steer-" + (++steers), text: "Clarification received: " + text, phase: "commentary" };
      write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
      if (text.includes("FINISH-STEER")) {
        held.delete(params.threadId);
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }
      return;
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      log({ method: message.method ?? null, id: message.id ?? null, params: message.params ?? null });
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;
