import fs from "node:fs/promises";
import path from "node:path";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveStateDir } from "../paths.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

export type AgentScopeSessionMeta = {
  sessionKey?: string;
  channel?: string;
  chatType?: string;
};

export type AgentScopedSessionResolver = {
  resolveSessionIdFromSessionKey: (sessionKey: string) => Promise<string | undefined>;
  resolveAgentIdFromSessionKey: (sessionKey: string) => Promise<string | undefined>;
  listAgentSessionIds: (agentId: string) => Promise<string[]>;
  resolveSessionMeta: (sessionId: string) => Promise<AgentScopeSessionMeta | undefined>;
};

type AgentScopedSessionResolverDeps = {
  resolveStorePath: typeof resolveStorePath;
  loadSessionStore: typeof loadSessionStore;
  readdir: typeof fs.readdir;
  resolveStateDir: typeof resolveStateDir;
};

const DEFAULT_DEPS: AgentScopedSessionResolverDeps = {
  resolveStorePath,
  loadSessionStore,
  readdir: fs.readdir,
  resolveStateDir,
};

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSessionMeta(entry: SessionEntry): AgentScopeSessionMeta | undefined {
  const channel = asTrimmedString(entry.channel) ?? asTrimmedString(entry.lastChannel);
  const chatType = asTrimmedString(entry.chatType);
  if (!channel && !chatType) {
    return undefined;
  }
  return {
    channel,
    chatType,
  };
}

function listSessionEntriesByUpdatedAtDesc(
  store: Record<string, SessionEntry>,
): Array<[string, SessionEntry]> {
  return Object.entries(store).toSorted(([, left], [, right]) => {
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  });
}

async function listKnownAgentIds(deps: AgentScopedSessionResolverDeps): Promise<string[]> {
  try {
    const baseDir = path.join(deps.resolveStateDir(), "agents");
    const entries = await deps.readdir(baseDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.trim().length > 0);
  } catch {
    return [];
  }
}

export function createAgentScopedSessionResolver(
  deps: Partial<AgentScopedSessionResolverDeps> = {},
): AgentScopedSessionResolver {
  const resolvedDeps: AgentScopedSessionResolverDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  const resolveAgentIdFromSessionKey: AgentScopedSessionResolver["resolveAgentIdFromSessionKey"] =
    async (sessionKey) => {
      const parsed = parseAgentSessionKey(sessionKey);
      return asTrimmedString(parsed?.agentId);
    };

  return {
    resolveAgentIdFromSessionKey,

    resolveSessionIdFromSessionKey: async (sessionKey) => {
      const key = asTrimmedString(sessionKey);
      if (!key) {
        return undefined;
      }
      const parsed = parseAgentSessionKey(key);
      const agentId = asTrimmedString(parsed?.agentId);
      if (!agentId) {
        return undefined;
      }
      try {
        const storePath = resolvedDeps.resolveStorePath(undefined, { agentId });
        const store = resolvedDeps.loadSessionStore(storePath);
        return asTrimmedString(store[key]?.sessionId);
      } catch {
        return undefined;
      }
    },

    listAgentSessionIds: async (agentId) => {
      const normalizedAgentId = asTrimmedString(agentId);
      if (!normalizedAgentId) {
        return [];
      }
      try {
        const storePath = resolvedDeps.resolveStorePath(undefined, { agentId: normalizedAgentId });
        const store = resolvedDeps.loadSessionStore(storePath);
        const ordered = listSessionEntriesByUpdatedAtDesc(store);
        const ids = new Set<string>();
        for (const [, entry] of ordered) {
          const sessionId = asTrimmedString(entry.sessionId);
          if (sessionId) {
            ids.add(sessionId);
          }
        }
        return [...ids];
      } catch {
        return [];
      }
    },

    resolveSessionMeta: async (sessionId) => {
      const targetSessionId = asTrimmedString(sessionId);
      if (!targetSessionId) {
        return undefined;
      }

      let best:
        | {
            updatedAt: number;
            meta: AgentScopeSessionMeta;
          }
        | undefined;

      const agentIds = await listKnownAgentIds(resolvedDeps);
      for (const agentId of agentIds) {
        try {
          const storePath = resolvedDeps.resolveStorePath(undefined, { agentId });
          const store = resolvedDeps.loadSessionStore(storePath);
          for (const [sessionKey, entry] of Object.entries(store)) {
            if (entry.sessionId !== targetSessionId) {
              continue;
            }
            const normalized = normalizeSessionMeta(entry);
            const meta: AgentScopeSessionMeta = {
              sessionKey,
              ...normalized,
            };
            const updatedAt = entry.updatedAt ?? 0;
            if (!best || updatedAt > best.updatedAt) {
              best = { updatedAt, meta };
            }
          }
        } catch {
          // ignore unreadable or missing stores
        }
      }

      return best?.meta;
    },
  };
}
