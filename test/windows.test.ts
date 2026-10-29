import { describe, expect, it } from "vitest";
import {
  parseCron,
  parseGoDuration,
  syncVerdict,
  windowState,
} from "../src/windows.js";

const at = (iso: string) => Date.parse(iso);

describe("cron and durations", () => {
  it("parses ranges, steps, lists and names", () => {
    const cron = parseCron("*/15 9-17 * JAN,jun mon-fri");
    expect([...cron.minute.values]).toEqual([0, 15, 30, 45]);
    expect([...cron.hour.values]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron.month.values]).toEqual([1, 6]);
    expect([...cron.dow.values]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("0 0 * * 7").dow.values]).toEqual([0]);
    expect(() => parseCron("0 0 * *")).toThrow(/5 cron fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/out of range/);
  });

  it("expands robfig descriptors", () => {
    for (const [descriptor, cron] of [
      ["@yearly", "0 0 1 1 *"],
      ["@annually", "0 0 1 1 *"],
      ["@monthly", "0 0 1 * *"],
      ["@weekly", "0 0 * * 0"],
      ["@daily", "0 0 * * *"],
      ["@midnight", "0 0 * * *"],
      ["@hourly", "0 * * * *"],
    ] as const)
      expect(parseCron(descriptor), descriptor).toEqual(parseCron(cron));
    expect(() => parseCron("@sometimes")).toThrow();
  });

  it("parses Go durations", () => {
    expect(parseGoDuration("1h30m")).toBe(90 * 60_000);
    expect(parseGoDuration("45s")).toBe(45_000);
    expect(() => parseGoDuration("1 day")).toThrow();
  });
});

describe("window state (Argo CD semantics)", () => {
  const nightly = { kind: "deny", schedule: "0 22 * * *", duration: "8h" };

  it("is active within duration after a fire, in UTC by default", () => {
    expect(windowState(nightly, at("2026-10-28T23:30:00Z")).active).toBe(true);
    expect(windowState(nightly, at("2026-10-29T05:59:00Z")).active).toBe(true);
    const after = windowState(nightly, at("2026-10-29T06:01:00Z"));
    expect(after.active).toBe(false);
    expect(new Date(after.nextStart ?? 0).toISOString()).toBe(
      "2026-10-29T22:00:00.000Z",
    );
  });

  it("honours the window's time zone", () => {
    const berlin = { ...nightly, timeZone: "Europe/Berlin" };
    // 21:30 UTC is 22:30 in Berlin (CET, UTC+1) on 2026-11-02.
    expect(windowState(berlin, at("2026-11-02T21:30:00Z")).active).toBe(true);
    expect(windowState(nightly, at("2026-11-02T21:30:00Z")).active).toBe(false);
  });

  it("uses OR when both day fields are restricted, AND when one is a wildcard", () => {
    const either = { kind: "allow", schedule: "0 12 1 * mon", duration: "1h" };
    // 2026-11-02 is a Monday, not the 1st.
    expect(windowState(either, at("2026-11-02T12:30:00Z")).active).toBe(true);
    expect(windowState(either, at("2026-11-01T12:30:00Z")).active).toBe(true);
    expect(windowState(either, at("2026-11-03T12:30:00Z")).active).toBe(false);
  });

  it("treats @hourly like its cron form", () => {
    const hourly = { kind: "deny", schedule: "@hourly", duration: "10m" };
    expect(windowState(hourly, at("2026-10-28T23:05:00Z")).active).toBe(true);
    expect(windowState(hourly, at("2026-10-28T23:30:00Z")).active).toBe(false);
  });

  it("reports invalid schedules and zones instead of guessing", () => {
    expect(windowState({ schedule: "bad", duration: "1h" }, 0).error).toMatch(
      /cron/,
    );
    expect(
      windowState(
        { schedule: "* * * * *", duration: "1h", timeZone: "Mars/Base" },
        0,
      ).error,
    ).toMatch(/time zone/);
  });
});

describe("sync verdict (CanSync)", () => {
  const now = at("2026-10-28T23:00:00Z");
  const activeDeny = { kind: "deny", schedule: "0 22 * * *", duration: "8h" };
  const inactiveAllow = {
    kind: "allow",
    schedule: "0 9 * * *",
    duration: "1h",
  };
  const activeAllow = { kind: "allow", schedule: "0 22 * * *", duration: "2h" };

  it("allows everything without windows", () => {
    expect(syncVerdict([], now)).toMatchObject({
      automated: "allowed",
      manual: "allowed",
    });
  });

  it("blocks on an active deny; manual only if every active deny allows it", () => {
    expect(syncVerdict([activeDeny], now)).toMatchObject({
      automated: "blocked",
      manual: "blocked",
    });
    expect(
      syncVerdict([{ ...activeDeny, manualSync: true }], now),
    ).toMatchObject({ automated: "blocked", manual: "allowed" });
    expect(
      syncVerdict(
        [
          { ...activeDeny, manualSync: true },
          { ...activeDeny, schedule: "0 21 * * *" },
        ],
        now,
      ),
    ).toMatchObject({ manual: "blocked" });
  });

  it("deny wins over an active allow", () => {
    expect(syncVerdict([activeDeny, activeAllow], now)).toMatchObject({
      automated: "blocked",
    });
  });

  it("needs an active allow when allow windows exist", () => {
    expect(syncVerdict([activeAllow], now)).toMatchObject({
      automated: "allowed",
      manual: "allowed",
    });
    expect(syncVerdict([inactiveAllow], now)).toMatchObject({
      automated: "blocked",
      manual: "blocked",
    });
    expect(
      syncVerdict([{ ...inactiveAllow, manualSync: true }], now),
    ).toMatchObject({ automated: "blocked", manual: "allowed" });
  });

  it("is unknown when an unparseable window could change the outcome", () => {
    const broken = { kind: "deny", schedule: "every night", duration: "8h" };
    const none = syncVerdict([broken], now);
    expect(none).toMatchObject({ automated: "unknown", manual: "unknown" });
    expect(none.reason).toContain(
      'deny window "every night" could not be evaluated',
    );
    expect(
      syncVerdict([inactiveAllow, { ...broken, kind: "allow" }], now),
    ).toMatchObject({ automated: "unknown", manual: "unknown" });
    expect(
      syncVerdict([activeAllow, { ...broken, kind: "allow" }], now),
    ).toMatchObject({ automated: "allowed", manual: "allowed" });
    expect(syncVerdict([activeAllow, broken], now)).toMatchObject({
      automated: "unknown",
    });
    expect(
      syncVerdict([{ ...activeDeny, manualSync: true }, broken], now),
    ).toMatchObject({ automated: "blocked", manual: "unknown" });
    expect(syncVerdict([activeDeny, broken], now)).toMatchObject({
      automated: "blocked",
      manual: "blocked",
    });
    expect(
      syncVerdict([{ ...activeDeny, timeZone: "Mars/Base" }], now),
    ).toMatchObject({ automated: "unknown", manual: "unknown" });
  });

  it("evaluates descriptor schedules instead of ignoring them", () => {
    expect(
      syncVerdict([{ kind: "deny", schedule: "@daily", duration: "24h" }], now),
    ).toMatchObject({ automated: "blocked", manual: "blocked" });
    expect(
      syncVerdict(
        [{ kind: "deny", schedule: "@every 1h", duration: "2h" }],
        now,
      ),
    ).toMatchObject({ automated: "blocked" });
    expect(
      syncVerdict(
        [{ kind: "deny", schedule: "@every 3h", duration: "2h" }],
        now,
      ),
    ).toMatchObject({ automated: "allowed" });
  });
});
