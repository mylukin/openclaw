import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../cli/lesson-engine.js";
import type { DedupeResult } from "../src/dedupe.js";
import type { ForgetResult } from "../src/forget.js";
import type { MigrateResult } from "../src/migrate.js";
import { makeFixture, writeLessons } from "./helpers.js";

describe("CLI", () => {
  test("rejects unknown agent with exit code 1", () => {
    const { stdout, exitCode } = main(["migrate", "--agent", "nope"]);
    expect(exitCode).toBe(1);
    expect((stdout as { error: string }).error).toMatch(/Unknown agent/);
  });

  test("migrate --dry-run reports diff without writing", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        lessons: [{ id: "l1", title: "t" }],
      });
      const before = fs.readFileSync(filePath, "utf8");
      const { stdout, exitCode } = main([
        "migrate",
        "--agent",
        "builder",
        "--dry-run",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const results = (stdout as { results: MigrateResult[] }).results;
      expect(results[0].wrote).toBe(false);
      expect(results[0].mutatedCount).toBeGreaterThan(0);
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      fx.cleanup();
    }
  });

  test("migrate --apply writes migrated file + backup", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        lessons: [{ id: "l1", severity: "critical", title: "t" }],
      });
      const { stdout, exitCode } = main([
        "migrate",
        "--agent",
        "builder",
        "--apply",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const results = (stdout as { results: MigrateResult[] }).results;
      expect(results[0].wrote).toBe(true);
      expect(fs.existsSync(results[0].backupPath!)).toBe(true);
      const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(after.lessons[0].severity).toBe("high");
    } finally {
      fx.cleanup();
    }
  });

  test("maintenance --apply updates shared maintenance-state.json", () => {
    const fx = makeFixture();
    try {
      const lessons = [];
      for (let i = 0; i < 52; i++) {
        lessons.push({
          id: `L-${i}`,
          title: `lesson ${i}`,
          category: "general",
          tags: [`t${i}`],
          severity: "medium",
          createdAt: new Date(Date.now() - i * 86400_000).toISOString(),
          hitCount: 0,
          appliedCount: 0,
          lastHitAt: null,
          mergedFrom: [],
          duplicateOf: null,
          lifecycle: "active",
        });
      }
      writeLessons(fx, "builder", { version: 1, lessons });
      const { stdout, exitCode } = main([
        "maintenance",
        "--agent",
        "builder",
        "--apply",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const results = (
        stdout as {
          results: { dedupe: DedupeResult; forget: ForgetResult; statePath?: string }[];
        }
      ).results;
      expect(results[0].forget.wrote).toBe(true);
      expect(results[0].forget.activeAfter).toBeLessThanOrEqual(50);
      const statePath = results[0].statePath!;
      expect(statePath).toBeDefined();
      expect(fs.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(state.version).toBe(1);
      expect(state.agents.builder.lastMaintenanceAt).toBeTruthy();
      expect(state.agents.builder.forgetStale).toBeGreaterThanOrEqual(2);
      expect(statePath.startsWith(fx.root)).toBe(true);
      const after = JSON.parse(
        fs.readFileSync(path.join(fx.root, "builder", "memory", "lessons-learned.json"), "utf8"),
      );
      expect(after.lessons.length).toBe(52);
    } finally {
      fx.cleanup();
    }
  });

  test("status reports per-lifecycle counts", () => {
    const fx = makeFixture();
    try {
      writeLessons(fx, "builder", {
        version: 1,
        lessons: [
          { id: "a", lifecycle: "active" },
          { id: "b", lifecycle: "stale" },
          { id: "c", lifecycle: "archive" },
        ],
      });
      const { stdout, exitCode } = main(["status", "--agent", "builder", "--root", fx.root]);
      expect(exitCode).toBe(0);
      const r = (stdout as { results: { active: number; stale: number; archive: number }[] })
        .results[0];
      expect(r.active).toBe(1);
      expect(r.stale).toBe(1);
      expect(r.archive).toBe(1);
    } finally {
      fx.cleanup();
    }
  });
});
