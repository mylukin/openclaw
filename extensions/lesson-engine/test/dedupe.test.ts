import { describe, expect, test } from "vitest";
import { dedupeData, DEDUPE_THRESHOLD } from "../src/dedupe.js";
import { makeFile, makeLesson } from "./helpers.js";

describe("dedupe", () => {
  test("merge keeps higher-severity lesson and archives the loser", () => {
    const file = makeFile([
      makeLesson({
        id: "A",
        title: "pnpm install hooks",
        tags: ["pnpm", "install"],
        category: "infra",
        severity: "medium",
      }),
      makeLesson({
        id: "B",
        title: "pnpm install hooks",
        tags: ["pnpm", "install"],
        category: "infra",
        severity: "high",
      }),
    ]);
    const { next, merges } = dedupeData(file);
    expect(merges).toHaveLength(1);
    expect(merges[0].keepId).toBe("B");
    expect(merges[0].mergedId).toBe("A");
    expect(merges[0].similarity).toBeGreaterThanOrEqual(DEDUPE_THRESHOLD);
    const b = next.lessons.find((l) => l.id === "B")!;
    const a = next.lessons.find((l) => l.id === "A")!;
    expect(b.lifecycle).toBe("active");
    expect(a.lifecycle).toBe("archive");
    expect(a.duplicateOf).toBe("B");
    expect(b.mergedFrom).toEqual(["A"]);
  });

  test("merge keeps higher hitCount when severity ties", () => {
    const file = makeFile([
      makeLesson({
        id: "A",
        title: "flaky build cache invalidation",
        tags: ["cache", "build"],
        category: "ci",
        hitCount: 1,
      }),
      makeLesson({
        id: "B",
        title: "flaky build cache invalidation",
        tags: ["cache", "build"],
        category: "ci",
        hitCount: 7,
      }),
    ]);
    const { merges } = dedupeData(file);
    expect(merges[0].keepId).toBe("B");
    expect(merges[0].mergedId).toBe("A");
  });

  test("mergedFrom/duplicateOf/lifecycle form a complete audit chain", () => {
    const file = makeFile([
      makeLesson({
        id: "KEEP",
        title: "same same same",
        tags: ["x"],
        category: "k",
        severity: "high",
      }),
      makeLesson({
        id: "MERGE1",
        title: "same same same",
        tags: ["y"],
        category: "k",
        severity: "low",
      }),
    ]);
    const { next } = dedupeData(file);
    const keep = next.lessons.find((l) => l.id === "KEEP")!;
    const merged = next.lessons.find((l) => l.id === "MERGE1")!;
    expect(keep.mergedFrom).toContain("MERGE1");
    expect(merged.duplicateOf).toBe("KEEP");
    expect(merged.lifecycle).toBe("archive");
    expect(keep.lifecycle).toBe("active");
  });

  test("tags are unioned on the surviving lesson", () => {
    const file = makeFile([
      makeLesson({
        id: "A",
        title: "duplicate tags union test",
        tags: ["a", "b"],
        category: "x",
        severity: "high",
      }),
      makeLesson({
        id: "B",
        title: "duplicate tags union test",
        tags: ["b", "c"],
        category: "x",
        severity: "low",
      }),
    ]);
    const { next } = dedupeData(file);
    const keep = next.lessons.find((l) => l.id === "A")!;
    expect(new Set(keep.tags)).toEqual(new Set(["a", "b", "c"]));
  });

  test("below-threshold pairs are left alone", () => {
    const file = makeFile([
      makeLesson({
        id: "A",
        title: "completely different topic alpha",
        tags: ["alpha"],
        category: "red",
      }),
      makeLesson({
        id: "B",
        title: "totally unrelated matter beta zebra",
        tags: ["beta"],
        category: "blue",
      }),
    ]);
    const { merges, next } = dedupeData(file);
    expect(merges).toHaveLength(0);
    expect(next.lessons.every((l) => l.lifecycle === "active")).toBe(true);
  });
});
