import { describe, expect, it } from "vitest";
import {
  PROGRESSING_ATTENTION_MINUTES,
  attentionReasons,
  autoSyncSummary,
  displayNames,
  isResourceProblem,
  shortRevision,
  sortApps,
  type Application,
} from "../src/model.js";

const now = Date.parse("2026-10-28T12:00:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function app(
  status: Application["status"],
  name = "a",
  extra: Partial<Application> = {},
): Application {
  return {
    metadata: { name, namespace: "argocd" },
    spec: { project: "default" },
    status,
    ...extra,
  };
}

describe("needs attention (decision A6)", () => {
  it("is empty for a synced, healthy app", () => {
    expect(
      attentionReasons(
        app({ sync: { status: "Synced" }, health: { status: "Healthy" } }),
        now,
      ),
    ).toEqual([]);
  });

  it("uses N = 10 minutes for Progressing", () => {
    expect(PROGRESSING_ATTENTION_MINUTES).toBe(10);
    const progressing = (minutes: number) =>
      attentionReasons(
        app({
          sync: { status: "Synced" },
          health: { status: "Progressing", lastTransitionTime: ago(minutes) },
        }),
        now,
      );
    expect(progressing(10)).toEqual([]);
    expect(progressing(11)).toEqual(["Progressing for 11m"]);
    expect(progressing(180)).toEqual(["Progressing for 3h"]);
  });

  it("never derives a Progressing duration from the last operation", () => {
    expect(
      attentionReasons(
        app({
          sync: { status: "Synced" },
          health: { status: "Progressing" },
          operationState: { startedAt: ago(3 * 24 * 60), finishedAt: ago(30) },
        }),
        now,
      ),
    ).toEqual([]);
    expect(
      attentionReasons(
        app({ sync: { status: "Synced" }, health: { status: "Progressing" } }),
        now,
      ),
    ).toEqual([]);
  });

  it("collects every reason: sync, health, failed operation, conditions", () => {
    expect(
      attentionReasons(
        app({
          sync: { status: "OutOfSync" },
          health: { status: "Degraded", message: "crashloop" },
          operationState: { phase: "Failed", message: "apply failed" },
          conditions: [{ type: "SyncError", message: "boom" }],
        }),
        now,
      ),
    ).toEqual([
      "OutOfSync",
      "Degraded: crashloop",
      "last sync Failed: apply failed",
      "SyncError: boom",
    ]);
    expect(
      attentionReasons(
        app({ sync: { status: "Unknown" }, health: { status: "Unknown" } }),
        now,
      ),
    ).toEqual(["sync Unknown", "health Unknown"]);
    expect(
      attentionReasons(
        app({ sync: { status: "Synced" }, health: { status: "Missing" } }),
        now,
      ),
    ).toEqual(["Missing"]);
  });

  it("clips attention messages before adding their labels", () => {
    const message = "x".repeat(100);
    const clipped = `${"x".repeat(77)}...`;
    expect(
      attentionReasons(
        app({
          sync: { status: "Synced" },
          health: { status: "Degraded", message },
          operationState: { phase: "Failed", message },
          conditions: [{ type: "SyncError", message }],
        }),
        now,
      ),
    ).toEqual([
      `Degraded: ${clipped}`,
      `last sync Failed: ${clipped}`,
      `SyncError: ${clipped}`,
    ]);
  });

  it("does not count Suspended as unhealthy", () => {
    expect(
      attentionReasons(
        app({ sync: { status: "Synced" }, health: { status: "Suspended" } }),
        now,
      ),
    ).toEqual([]);
    expect(
      isResourceProblem({ status: "Synced", health: { status: "Suspended" } }),
    ).toBe(false);
    expect(isResourceProblem({ status: "Synced", requiresPruning: true })).toBe(
      true,
    );
  });
});

describe("app helpers", () => {
  it("sorts problems first, then by health, then by name", () => {
    const sorted = sortApps(
      [
        app({ sync: { status: "Synced" }, health: { status: "Healthy" } }, "b"),
        app(
          { sync: { status: "OutOfSync" }, health: { status: "Healthy" } },
          "z",
        ),
        app({ sync: { status: "Synced" }, health: { status: "Healthy" } }, "a"),
        app({ sync: { status: "Synced" }, health: { status: "Missing" } }, "y"),
      ],
      now,
    ).map((a) => a.metadata?.name);
    expect(sorted).toEqual(["y", "z", "a", "b"]);
  });

  it("qualifies names with the namespace only when apps span namespaces (A9)", () => {
    const one = [app(undefined, "a"), app(undefined, "b")];
    expect(one.map(displayNames(one))).toEqual(["a", "b"]);
    const two = [
      app(undefined, "a"),
      { ...app(undefined, "b"), metadata: { name: "b", namespace: "team-a" } },
    ];
    expect(two.map(displayNames(two))).toEqual(["argocd/a", "team-a/b"]);
  });

  it("shortens commit SHAs only", () => {
    expect(shortRevision("4c1a3d7f9e2b6a8c0d1e2f3a4b5c6d7e8f9a0b1c")).toBe(
      "4c1a3d7",
    );
    expect(shortRevision("1.2.3")).toBe("1.2.3");
  });

  it("summarises auto-sync", () => {
    expect(autoSyncSummary(app(undefined))).toBe("manual");
    expect(
      autoSyncSummary({
        spec: { syncPolicy: { automated: { prune: true, selfHeal: true } } },
      }),
    ).toBe("automated (prune, self-heal)");
    expect(
      autoSyncSummary({
        spec: { syncPolicy: { automated: { enabled: false } } },
      }),
    ).toBe("manual");
  });
});
