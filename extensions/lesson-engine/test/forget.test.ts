import { describe, expect, test } from "vitest";
import { DEFAULT_MAX_ACTIVE, forgetData, scoreLesson } from "../src/forget.js";
import { makeFile, makeLesson } from "./helpers.js";

const NOW = new Date("2026-04-13T00:00:00Z");

describe("forget scoring", () => {
  test("score components for a fresh high-severity lesson", () => {
    const lesson = makeLesson({
      id: "X",
      severity: "high",
      createdAt: "2026-04-13T00:00:00Z",
      hitCount: 0,
      appliedCount: 0,
    });
    const s = scoreLesson(lesson, NOW);
    expect(s.recency).toBeCloseTo(1.0, 5);
    expect(s.usefulness).toBe(0);
    expect(s.severity).toBe(1.0);
    // 0.4*1 + 0.4*0 + 0.2*1 = 0.6
    expect(s.total).toBeCloseTo(0.6, 5);
  });

  test("usefulness saturates at 1", () => {
    const lesson = makeLesson({
      id: "X",
      severity: "low",
      createdAt: "2025-01-01T00:00:00Z",
      hitCount: 2,
      appliedCount: 5, // (2 + 10) / 10 = 1.2 clipped to 1
    });
    const s = scoreLesson(lesson, NOW);
    expect(s.usefulness).toBe(1);
    expect(s.severity).toBe(0.2);
  });

  test("severity weights: high=1.0 medium=0.5 low=0.2", () => {
    const base = { id: "X", createdAt: "2026-04-13T00:00:00Z" } as const;
    expect(scoreLesson(makeLesson({ ...base, severity: "high" }), NOW).severity).toBe(1.0);
    expect(scoreLesson(makeLesson({ ...base, severity: "medium" }), NOW).severity).toBe(0.5);
    expect(scoreLesson(makeLesson({ ...base, severity: "low" }), NOW).severity).toBe(0.2);
  });
});

describe("forget lifecycle transitions", () => {
  test("active > maxActive: lowest-scoring tail demoted to stale", () => {
    const lessons = [];
    for (let i = 0; i < DEFAULT_MAX_ACTIVE + 5; i++) {
      lessons.push(
        makeLesson({
          id: `L-${i}`,
          severity: "medium",
          // older (lower recency) ⇒ demoted first
          createdAt: new Date(NOW.getTime() - (i + 1) * 86400_000 * 60).toISOString(),
        }),
      );
    }
    const file = makeFile(lessons);
    const { next, transitions } = forgetData(file, { now: NOW });
    const active = next.lessons.filter((l) => l.lifecycle === "active");
    const stale = next.lessons.filter((l) => l.lifecycle === "stale");
    expect(active).toHaveLength(DEFAULT_MAX_ACTIVE);
    expect(stale).toHaveLength(5);
    expect(transitions.every((t) => t.from === "active" && t.to === "stale")).toBe(true);
    // oldest (highest i) should be the ones demoted
    expect(stale.map((l) => l.id).sort()).toEqual(["L-54", "L-53", "L-52", "L-51", "L-50"].sort());
  });

  test("stale + daysSinceLastHit > 90 → archive", () => {
    const lessons = [
      makeLesson({
        id: "old-stale",
        severity: "low",
        lifecycle: "stale",
        lastHitAt: null,
        createdAt: new Date(NOW.getTime() - 120 * 86400_000).toISOString(),
      }),
      makeLesson({
        id: "fresh-stale",
        severity: "low",
        lifecycle: "stale",
        lastHitAt: new Date(NOW.getTime() - 10 * 86400_000).toISOString(),
      }),
    ];
    const { next, transitions } = forgetData(makeFile(lessons), { now: NOW });
    const old = next.lessons.find((l) => l.id === "old-stale")!;
    const fresh = next.lessons.find((l) => l.id === "fresh-stale")!;
    expect(old.lifecycle).toBe("archive");
    expect(fresh.lifecycle).toBe("stale");
    expect(transitions).toContainEqual(
      expect.objectContaining({ id: "old-stale", from: "stale", to: "archive" }),
    );
  });

  test("never deletes: archived lessons stay in the file", () => {
    const lessons = [
      makeLesson({
        id: "a",
        severity: "low",
        lifecycle: "stale",
        createdAt: new Date(NOW.getTime() - 200 * 86400_000).toISOString(),
      }),
    ];
    const file = makeFile(lessons);
    const beforeCount = file.lessons.length;
    const { next } = forgetData(file, { now: NOW });
    expect(next.lessons).toHaveLength(beforeCount);
  });
});
