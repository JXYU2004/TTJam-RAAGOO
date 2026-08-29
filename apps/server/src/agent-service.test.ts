import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  return makeServiceIn(root, runner);
}

async function makeServiceIn(
  root: string,
  runner: AgentRunner = new FakeRunner(),
): Promise<AgentService> {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

describe("Glass Box Tracing", () => {
  it("creates a trace with lifecycle events when a run is executed", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Tracer" });
    const { run } = await service.sendMessage(agent.id, "build something");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const trace = service.getTrace(run.id);
    expect(trace.runId).toBe(run.id);
    expect(trace.agentId).toBe(agent.id);
    expect(trace.events.map((e) => e.type)).toEqual(["queued", "started", "completed"]);
    expect(trace.events[0]).toMatchObject({ type: "queued" });
    expect(trace.events[1]).toMatchObject({ type: "started" });
    expect(trace.events[2]).toMatchObject({ type: "completed" });
    // Verify timestamps are present and ordered
    const timestamps = trace.events.map((e) => new Date(e.timestamp).getTime());
    expect(timestamps[0] <= timestamps[1]).toBe(true);
    expect(timestamps[1] <= timestamps[2]).toBe(true);
  });

  it("includes error message in failed trace event", async () => {
    let finish!: (error: Error) => void;
    const pending = new Promise<RunnerResult>((_, reject) => {
      finish = reject;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "FailTracer" });
    const { run } = await service.sendMessage(agent.id, "fail please");

    // Reject with error in a way that doesn't cause unhandled rejection
    setTimeout(() => finish(new Error("Execution timeout")), 10);
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const trace = service.getTrace(run.id);
    expect(trace.events.map((e) => e.type)).toEqual(["queued", "started", "failed"]);
    expect(trace.events[2]).toMatchObject({
      type: "failed",
      message: "Execution timeout",
    });
  });

  it("marks trace event as cancelled when run is cancelled", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "CancelTracer" });
    const { run } = await service.sendMessage(agent.id, "cancel me");

    // Request cancellation
    const stopPromise = service.stopAgent(agent.id);
    await new Promise((resolve) => setTimeout(resolve, 50)); // Give stop time to process

    // Complete the run (will be marked as cancelled due to stopAgent)
    finish({ output: "", threadId: null, usage: null });

    await stopPromise;
    await expect.poll(() => service.getRun(run.id).status).toBe("cancelled");

    const trace = service.getTrace(run.id);
    expect(trace.events.map((e) => e.type)).toContain("cancelled");
  });

  it("deletes traces when an agent is deleted", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "DeleteTracer" });
    const { run } = await service.sendMessage(agent.id, "build");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    // Verify trace exists
    expect(service.getTrace(run.id)).toBeDefined();

    // Delete the agent
    await service.deleteAgent(agent.id);

    // Verify trace is gone
    expect(() => service.getTrace(run.id)).toThrow("Trace not found");
  });

  it("returns 404 when trace does not exist", async () => {
    const service = await makeService();
    expect(() => service.getTrace("nonexistent-run-id")).toThrow("Trace not found");
  });

  it("records cancellation in the trace when an active run is recovered after restart", async () => {
    const pending = new Promise<RunnerResult>(() => undefined);
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const service = await makeServiceIn(root, {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "RestartTracer" });
    const { run } = await service.sendMessage(agent.id, "wait for restart");

    await expect.poll(() => service.getRun(run.id).status).toBe("running");

    const restarted = await makeServiceIn(root);
    expect(restarted.getRun(run.id)).toMatchObject({ status: "cancelled" });
    expect(restarted.getTrace(run.id).events.at(-1)).toMatchObject({
      type: "cancelled",
      message: "Server restarted while this run was active",
    });
  });
});
