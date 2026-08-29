import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AgentService } from "./agent-service.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-test-"));
  temporaryDirectories.push(root);
  const runner: AgentRunner = {
    run: async (request: RunnerRequest): Promise<RunnerResult> => ({
      output: "Completed: " + request.prompt,
      threadId: "trace-test-thread",
      usage: null,
    }),
    cancel: async () => false,
    isAvailable: async () => true,
  };
  const service = new AgentService(
    loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    }),
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("returns a run trace from the control-plane API", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Trace API" });
    const { run } = await service.sendMessage(agent.id, "return the trace");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);

    const response = await app.inject({ method: "GET", url: "/api/runs/" + run.id + "/trace" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      trace: {
        runId: run.id,
        agentId: agent.id,
        events: [{ type: "queued" }, { type: "started" }, { type: "completed" }],
      },
    });
    await app.close();
  });
});
