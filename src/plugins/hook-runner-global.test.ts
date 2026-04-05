import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

async function importHookRunnerGlobalModule() {
  return import("./hook-runner-global.js");
}

afterEach(async () => {
  const mod = await importHookRunnerGlobalModule();
  mod.resetGlobalHookRunner();
  vi.resetModules();
});

describe("hook-runner-global", () => {
  it("preserves the initialized runner across module reloads", async () => {
    const modA = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);

    modA.initializeGlobalHookRunner(registry);
    expect(modA.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);

    vi.resetModules();

    const modB = await importHookRunnerGlobalModule();
    expect(modB.getGlobalHookRunner()).not.toBeNull();
    expect(modB.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);
    expect(modB.getGlobalPluginRegistry()).toBe(registry);
  });

  it("clears the shared state across module reloads", async () => {
    const modA = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);

    modA.initializeGlobalHookRunner(registry);

    vi.resetModules();

    const modB = await importHookRunnerGlobalModule();
    modB.resetGlobalHookRunner();
    expect(modB.getGlobalHookRunner()).toBeNull();
    expect(modB.getGlobalPluginRegistry()).toBeNull();

    vi.resetModules();

    const modC = await importHookRunnerGlobalModule();
    expect(modC.getGlobalHookRunner()).toBeNull();
    expect(modC.getGlobalPluginRegistry()).toBeNull();
  });

  it("carries forward hooks from the previous registry when the new one lacks them", async () => {
    const mod = await importHookRunnerGlobalModule();
    const handler = vi.fn();
    const oldRegistry = createMockPluginRegistry([{ hookName: "message_received", handler }]);
    mod.initializeGlobalHookRunner(oldRegistry);
    expect(mod.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);

    // Simulate a late plugin reload that produces a registry without the hook.
    const newRegistry = createMockPluginRegistry([]);
    // Give the new registry a different plugin id so it's clearly distinct.
    newRegistry.plugins = [{ ...newRegistry.plugins[0], id: "other-plugin" }];
    newRegistry.typedHooks = [];
    mod.initializeGlobalHookRunner(newRegistry);

    // The message_received hook from the old registry must survive.
    expect(mod.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);
  });

  it("does not duplicate hooks when the new registry already contains the same plugin", async () => {
    const mod = await importHookRunnerGlobalModule();
    const handler = vi.fn();
    const registry1 = createMockPluginRegistry([{ hookName: "message_received", handler }]);
    mod.initializeGlobalHookRunner(registry1);

    // Re-initialize with a registry that has the same plugin id's hooks.
    const registry2 = createMockPluginRegistry([{ hookName: "message_received", handler }]);
    mod.initializeGlobalHookRunner(registry2);

    expect(mod.getGlobalHookRunner()?.getHookCount("message_received")).toBe(1);
  });
});
