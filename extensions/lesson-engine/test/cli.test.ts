import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../bin/lesson-engine.js";
import type { Lesson } from "../src/types.js";
import { makeFile, makeFixture, makeLesson, writeLessons } from "./helpers.js";

describe("CLI (via main())", () => {
  test("no command → exit 1 with help", () => {
    const fx = makeFixture();
    try {
      const { exitCode, stderr } = main(["--root", fx.root]);
      expect(exitCode).toBe(1);
      expect(stderr.join("\n")).toContain("error:");
    } finally {
      fx.cleanup();
    }
  });

  test("unknown agent → exit 1", () => {
    const fx = makeFixture();
    try {
      const { exitCode, stderr } = main(["status", "--agent", "nobody", "--root", fx.root]);
      expect(exitCode).toBe(1);
      expect(stderr.join("\n")).toContain("Unknown agent");
    } finally {
      fx.cleanup();
    }
  });

  test("migrate --dry-run returns diff without writing", () => {
    const fx = makeFixture();
    try {
      writeLessons(fx, "builder", {
        version: 1,
        lessons: [{ id: "l1", title: "test" }],
      });
      const { stdout, exitCode } = main(["migrate", "--agent", "builder", "--root", fx.root]);
      expect(exitCode).toBe(0);
      const data = stdout as any;
      expect(data.command).toBe("migrate");
      expect(data.dryRun).toBe(true);
      expect(data.results[0].wrote).toBe(false);
      expect(data.results[0].mutatedCount).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("migrate --apply writes backup + migrated file", () => {
    const fx = makeFixture();
    try {
      writeLessons(fx, "builder", {
        version: 1,
        lessons: [{ id: "l1", title: "test" }],
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
      const data = stdout as any;
      expect(data.results[0].wrote).toBe(true);
      expect(data.results[0].backupPath).toBeTruthy();
      expect(fs.existsSync(data.results[0].backupPath)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  test("status --all reports counts for each agent", () => {
    const fx = makeFixture();
    try {
      writeLessons(
        fx,
        "builder",
        makeFile([
          makeLesson({ id: "l1", lifecycle: "active" }),
          makeLesson({ id: "l2", lifecycle: "stale" }),
          makeLesson({ id: "l3", lifecycle: "archive" }),
        ]),
      );
      writeLessons(fx, "architect", makeFile([makeLesson({ id: "a1", lifecycle: "active" })]));
      const { stdout, exitCode } = main(["status", "--all", "--root", fx.root]);
      expect(exitCode).toBe(0);
      const data = stdout as any;
      expect(data.results).toHaveLength(4);
      const b = data.results.find((r: any) => r.agent === "builder");
      expect(b.active).toBe(1);
      expect(b.stale).toBe(1);
      expect(b.archive).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("maintenance --apply writes maintenance-state.json", () => {
    const fx = makeFixture();
    try {
      const lessons: Lesson[] = [];
      for (let i = 0; i < 55; i++) {
        lessons.push(
          makeLesson({
            id: `l-${i}`,
            title: `Unique lesson number ${i} about topic ${i}`,
            severity: i < 5 ? "low" : "high",
            hitCount: i < 5 ? 0 : 5,
            createdAt: i < 5 ? "2025-01-01T00:00:00Z" : "2026-04-01T00:00:00Z",
            lastHitAt: i < 5 ? null : "2026-04-12T00:00:00Z",
          }),
        );
      }
      writeLessons(fx, "builder", makeFile(lessons));
      for (const agent of ["architect", "chief", "growth"] as const) {
        writeLessons(fx, agent, makeFile([]));
      }
      const { stdout, exitCode } = main(["maintenance", "--all", "--apply", "--root", fx.root]);
      expect(exitCode).toBe(0);

      const msPath = path.join(fx.root, "shared", "lessons", "maintenance-state.json");
      expect(fs.existsSync(msPath)).toBe(true);
      const ms = JSON.parse(fs.readFileSync(msPath, "utf8"));
      expect(ms.version).toBe(1);
      expect(ms.agents.builder).toBeDefined();
    } finally {
      fx.cleanup();
    }
  });
});
