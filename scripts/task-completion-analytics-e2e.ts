// Real SQLite analytics and Team wire roundtrips, with isolated dated fixtures and no provider calls.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeHostAnalytics } from "@openbot/contracts/ipc";
import { TEAM_CURRENT_CAPABILITIES, teamCapabilitiesVisibleToProtocol } from "@openbot/contracts/team-protocol/current";
import {
  HOST_TASK_COMPLETIONS_CAPABILITY,
  HOST_TASK_COMPLETIONS_ROUTE,
} from "@openbot/contracts/team-protocol/host-task-completions-v1";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import { decodeHostAnalyticsV1Response } from "../packages/contracts/src/team-protocol/host-analytics-v1";
import { AgentThreadStore } from "../src/backend/agent-threads/agent-thread-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const root = await mkdtemp(join(tmpdir(), "openbot-completions-"));
const database = new OpenBotDatabase(root);
const threads = new AgentThreadStore(database);
const checks: string[] = [];
const out = resolve(".openbot-build/task-completion-analytics-e2e");
let passed = false;
try {
  await runCauseEffect(database.initialize());
  const create = (agentId = "chief") =>
    threads.create({ agentId, origin: "user", title: "Fixture", titleSource: "auto" });
  const turn = (threadId: string, id: string, status: string, completedAt: string | null) => {
    database.connection
      .prepare(`INSERT INTO projection_turns
      (turn_id, thread_id, status, started_at, completed_at, last_event_sequence)
      VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', ?, 1)`)
      .run(id, threadId, status, completedAt);
  };
  const read = (month: "10" | "11", timeZone = "UTC", agentId: string | undefined = "chief") =>
    database.usage.readHost({
      agentId,
      startDate: `2026-${month}-01`,
      endDate: `2026-${month}-${month === "10" ? "31" : "30"}`,
      timeZone,
    });
  const first = create();
  turn(first.threadId, "first-success", "completed", "2026-10-31T23:30:00.000Z");
  turn(first.threadId, "later-success", "completed", "2026-11-11T12:00:00.000Z");
  threads.setOutcome(first.taskId, "completed");
  assert.equal(read("10").completedTasks, 1);
  assert.equal(read("11").completedTasks, 0);
  checks.push(
    "A task counts once in its first successful completion month, despite later successful turns and no assistant messages.",
  );
  threads.rename(first.threadId, "Renamed");
  threads.close(first.taskId);
  assert.equal(read("10").completedTasks, 1);
  threads.reopen(first.taskId);
  threads.touch(first.taskId);
  assert.equal(read("10").completedTasks, 1);
  turn(first.threadId, "later-failure", "failed", "2026-11-12T12:00:00.000Z");
  threads.setOutcome(first.taskId, "failed");
  assert.equal(read("10").completedTasks, 1);
  checks.push(
    "Rename, archive/restore, new activity and a later failure do not move or erase a historical completion.",
  );
  const boundary = create();
  turn(boundary.threadId, "boundary", "completed", "2026-11-01T01:00:00.000Z");
  assert.equal(read("11").completedTasks, 1);
  assert.equal(read("11", "America/Sao_Paulo").completedTasks, 0);
  assert.equal(read("10", "America/Sao_Paulo").completedTasks, 2);
  checks.push("Month boundaries follow the requested time zone, not the UTC date or task update date.");
  for (const status of ["failed", "interrupted", "running"]) {
    const task = create();
    turn(task.threadId, status, status, status === "running" ? null : "2026-11-10T00:00:00.000Z");
  }
  const unknown = create();
  threads.setOutcome(unknown.taskId, "completed");
  const unknownDate = create();
  turn(unknownDate.threadId, "unknown-date", "completed", null);
  assert.equal(read("11").completedTasks, 1);
  checks.push(
    "Failed, interrupted, running, unstarted and undated legacy tasks add no invented completion and do not block dated tasks.",
  );
  const other = create("other-agent");
  turn(other.threadId, "other-agent", "completed", "2026-11-11T00:00:00.000Z");
  for (let index = 0; index < 55; index++) {
    const task = create();
    turn(task.threadId, `archived-${index}`, "completed", "2026-11-10T12:00:00.000Z");
    threads.close(task.taskId);
  }
  assert.equal(read("11").completedTasks, 56);
  assert.equal(read("11", "UTC", "other-agent").completedTasks, 1);
  const host = database.usage.readHost({ startDate: "2026-11-01", endDate: "2026-11-30", timeZone: "UTC" });
  assert.equal(host.completedTasks, 57);
  checks.push("All 55 archived fixtures count beyond the task list limit, while agent and host scopes stay separate.");
  database.close();
  await runCauseEffect(database.initialize());
  const report = read("11");
  assert.equal(report.completedTasks, 56);
  checks.push("The first-completion month survives closing and reopening the real SQLite database.");
  const codec = teamSideRouteCodec(HOST_TASK_COMPLETIONS_ROUTE);
  assert(codec);
  const wire = JSON.parse(JSON.stringify(codec.response(HOST_TASK_COMPLETIONS_ROUTE, 200, report)));
  assert.equal(decodeHostAnalytics(wire).completedTasks, 56);
  const legacy = decodeHostAnalyticsV1Response(report);
  assert.equal(decodeHostAnalytics(legacy).completedTasks, undefined);
  assert.throws(() => codec.response(HOST_TASK_COMPLETIONS_ROUTE, 200, { ...report, completedTasks: -1 }));
  assert.throws(() => codec.response(HOST_TASK_COMPLETIONS_ROUTE, 200, { ...report, completedTasks: undefined }));
  assert(!teamCapabilitiesVisibleToProtocol(TEAM_CURRENT_CAPABILITIES, 8).includes(HOST_TASK_COMPLETIONS_CAPABILITY));
  assert(teamCapabilitiesVisibleToProtocol(TEAM_CURRENT_CAPABILITIES, 9).includes(HOST_TASK_COMPLETIONS_CAPABILITY));
  checks.push(
    "The new optional wire roundtrip retains the count, rejects invalid values and leaves released host analytics and protocol 8 unchanged.",
  );
  passed = true;
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed, checks }, null, 2)}\n`);
}
