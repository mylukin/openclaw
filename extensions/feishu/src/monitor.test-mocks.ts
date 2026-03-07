import type { Mock } from "vitest";
import { vi } from "vitest";

export const probeFeishuMock: Mock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuWSClient: vi.fn((): { start: Mock } => ({ start: vi.fn() })),
  createEventDispatcher: vi.fn((): { register: Mock } => ({ register: vi.fn() })),
}));
