import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { CLAUDE_CLI_PROVIDER_ID, getCliSessionId } from "./cli-session.js";

export type PhysicalContextLogger = {
  debug?: (msg: string) => void;
};

export type ResolvePhysicalContextIdParams = {
  /** Session-store key (e.g. dispatch key built from agent/account/chat). */
  sessionKey: string;
  /** Optional agent id used to resolve a per-agent store path. */
  agentId?: string;
  /** Pre-resolved path to a sessions.json file. Takes priority over `store`. */
  storePath?: string;
  /** Raw config value (e.g. `~/.openclaw/sessions/{agentId}.json`). */
  store?: string;
  /** CLI provider id. Defaults to `claude-cli`. */
  provider?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional logger for debug output when lookup steps fail. */
  logger?: PhysicalContextLogger;
};

/**
 * Resolve the physical CLI session id for a given session-store key.
 *
 * Reads the persisted CLI session binding (e.g. `claude-cli` session id) so a
 * caller can pass it as `physicalContextId` when invoking downstream dispatch
 * paths. Returns `undefined` when the store/entry/binding is missing — callers
 * are expected to fall back to their existing `sessionKey`-based behavior.
 *
 * Errors during store-path resolution or store load are caught and surfaced
 * via `logger.debug` (when provided) instead of throwing, so a transient I/O
 * failure does not crash the dispatch pipeline. Returning `undefined` keeps
 * the caller on the legacy `sessionKey` fallback path.
 */
export function resolvePhysicalContextId(
  params: ResolvePhysicalContextIdParams,
): string | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const logger = params.logger;
  let storePath: string;
  try {
    storePath =
      params.storePath ??
      resolveStorePath(params.store, {
        agentId: params.agentId,
        env: params.env,
      });
  } catch (err) {
    logger?.debug?.(
      `resolvePhysicalContextId: resolveStorePath failed (sessionKey=${sessionKey}): ${
        (err as Error)?.message ?? err
      }`,
    );
    return undefined;
  }
  let store: Record<string, SessionEntry | undefined> | undefined;
  try {
    store = loadSessionStore(storePath, { skipCache: true }) as Record<
      string,
      SessionEntry | undefined
    >;
  } catch (err) {
    logger?.debug?.(
      `resolvePhysicalContextId: loadSessionStore failed (storePath=${storePath}): ${
        (err as Error)?.message ?? err
      }`,
    );
    return undefined;
  }
  const entry = store
    ? resolveSessionStoreEntry({ store: store as Record<string, SessionEntry>, sessionKey })
        .existing
    : undefined;
  if (!entry) {
    return undefined;
  }
  return getCliSessionId(entry, params.provider ?? CLAUDE_CLI_PROVIDER_ID);
}
