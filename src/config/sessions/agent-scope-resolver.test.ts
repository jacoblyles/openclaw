import { describe, expect, it } from "vitest";
import {
  createAgentScopedSessionResolver,
  type AgentScopeSessionMeta,
} from "./agent-scope-resolver.js";
import type { SessionEntry } from "./types.js";

const STORE_PATH_PREFIX = "/stores/";

function storePathForAgent(agentId: string): string {
  return `${STORE_PATH_PREFIX}${agentId}.json`;
}

function createResolverForTest(params: {
  stores: Record<string, Record<string, SessionEntry>>;
  knownAgents: string[];
}) {
  const { stores, knownAgents } = params;
  return createAgentScopedSessionResolver({
    resolveStorePath: (_store, opts) => storePathForAgent(String(opts?.agentId ?? "main")),
    loadSessionStore: (storePath) => stores[storePath] ?? {},
    readdir: async () =>
      knownAgents.map((name) => ({
        name,
        isDirectory: () => true,
      })) as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>,
    resolveStateDir: () => "/state",
  });
}

describe("createAgentScopedSessionResolver", () => {
  it("resolves session id from agent-scoped session key", async () => {
    const resolver = createResolverForTest({
      knownAgents: ["main"],
      stores: {
        [storePathForAgent("main")]: {
          "agent:main:discord:direct:u1": {
            sessionId: "sess-main-1",
            updatedAt: 101,
          },
        },
      },
    });

    await expect(
      resolver.resolveSessionIdFromSessionKey("agent:main:discord:direct:u1"),
    ).resolves.toBe("sess-main-1");
    await expect(resolver.resolveSessionIdFromSessionKey("legacy-key")).resolves.toBeUndefined();
  });

  it("resolves agent id from prefixed session key only", async () => {
    const resolver = createResolverForTest({ knownAgents: [], stores: {} });

    await expect(
      resolver.resolveAgentIdFromSessionKey("agent:ops:telegram:group:g1"),
    ).resolves.toBe("ops");
    await expect(
      resolver.resolveAgentIdFromSessionKey("telegram:group:g1"),
    ).resolves.toBeUndefined();
  });

  it("lists unique session ids ordered by most recently updated", async () => {
    const resolver = createResolverForTest({
      knownAgents: ["ops"],
      stores: {
        [storePathForAgent("ops")]: {
          "agent:ops:discord:channel:1": {
            sessionId: "sess-1",
            updatedAt: 10,
          },
          "agent:ops:telegram:group:2": {
            sessionId: "sess-2",
            updatedAt: 200,
          },
          "agent:ops:web:direct:3": {
            sessionId: "sess-1",
            updatedAt: 150,
          },
        },
      },
    });

    await expect(resolver.listAgentSessionIds("ops")).resolves.toEqual(["sess-2", "sess-1"]);
    await expect(resolver.listAgentSessionIds("")).resolves.toEqual([]);
  });

  it("resolves session metadata using latest matching entry across known agents", async () => {
    const resolver = createResolverForTest({
      knownAgents: ["main", "ops"],
      stores: {
        [storePathForAgent("main")]: {
          "agent:main:discord:channel:alerts": {
            sessionId: "shared-session",
            channel: "discord",
            chatType: "channel",
            updatedAt: 100,
          },
        },
        [storePathForAgent("ops")]: {
          "agent:ops:telegram:group:devops": {
            sessionId: "shared-session",
            channel: "telegram",
            chatType: "group",
            updatedAt: 200,
          },
        },
      },
    });

    const meta = await resolver.resolveSessionMeta("shared-session");
    const expected: AgentScopeSessionMeta = {
      sessionKey: "agent:ops:telegram:group:devops",
      channel: "telegram",
      chatType: "group",
    };
    expect(meta).toEqual(expected);
    await expect(resolver.resolveSessionMeta("missing")).resolves.toBeUndefined();
  });
});
