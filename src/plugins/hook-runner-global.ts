/**
 * Global Plugin Hook Runner
 *
 * Singleton hook runner that's initialized when plugins are loaded
 * and can be called from anywhere in the codebase.
 * Uses globalThis to ensure singleton works across module instances.
 */

import type { PluginRegistry } from "./registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createHookRunner, type HookRunner } from "./hooks.js";

const log = createSubsystemLogger("plugins");

const GLOBAL_STATE_KEY = Symbol.for("openclaw.plugins.hookRunnerGlobal");

type GlobalHookState = {
  hookRunner: HookRunner | null;
  registry: PluginRegistry | null;
};

function getGlobalState(): GlobalHookState {
  const store = globalThis as unknown as Record<symbol, GlobalHookState>;
  if (!store[GLOBAL_STATE_KEY]) {
    store[GLOBAL_STATE_KEY] = { hookRunner: null, registry: null };
  }
  return store[GLOBAL_STATE_KEY];
}

/**
 * Initialize the global hook runner with a plugin registry.
 * Called once when plugins are loaded during gateway startup.
 */
export function initializeGlobalHookRunner(registry: PluginRegistry): void {
  const state = getGlobalState();
  state.registry = registry;
  state.hookRunner = createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
  });

  const hookCount = registry.typedHooks.length;
  if (hookCount > 0) {
    log.info(`hook runner initialized with ${hookCount} registered hooks`);
  }
}

/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner(): HookRunner | null {
  return getGlobalState().hookRunner;
}

/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalPluginRegistry(): PluginRegistry | null {
  return getGlobalState().registry;
}

/**
 * Check if any hooks are registered for a given hook name.
 */
export function hasGlobalHooks(hookName: Parameters<HookRunner["hasHooks"]>[0]): boolean {
  return getGlobalState().hookRunner?.hasHooks(hookName) ?? false;
}

/**
 * Reset the global hook runner (for testing).
 */
export function resetGlobalHookRunner(): void {
  const state = getGlobalState();
  state.hookRunner = null;
  state.registry = null;
}
