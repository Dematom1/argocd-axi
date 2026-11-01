import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWritableContext,
  configPath,
  loadConfig,
  parseConfig,
  removeWritableContext,
} from "../src/config.js";
import {
  ATTRIBUTION_INFO,
  attributionArgs,
  evaluateWriteGate,
  writableContextsSummary,
} from "../src/gate.js";

describe("config loader (decision A4)", () => {
  let previous: string | undefined;
  let dir: string;
  beforeEach(() => {
    previous = process.env.XDG_CONFIG_HOME;
    dir = mkdtempSync(join(tmpdir(), "argocd-axi-config-"));
    process.env.XDG_CONFIG_HOME = dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  });

  it("defaults to no writable contexts when the file is missing", () => {
    expect(configPath()).toBe(join(dir, "argocd-axi", "config"));
    expect(loadConfig()).toEqual({
      path: configPath(),
      exists: false,
      config: { writableContexts: [] },
    });
  });

  it("reads writable-contexts from YAML", () => {
    mkdirSync(join(dir, "argocd-axi"));
    writeFileSync(
      configPath(),
      "# local opt-in\nwritable-contexts:\n  - staging\n  - dev\n  - staging\n",
    );
    expect(loadConfig().config).toEqual({
      writableContexts: ["staging", "dev"],
    });
  });

  it("updates an empty or comments-only config and reports whether it changed", () => {
    expect(addWritableContext("staging")).toBe(true);
    expect(addWritableContext("staging")).toBe(false);
    expect(loadConfig().config).toEqual({ writableContexts: ["staging"] });
    expect(removeWritableContext("missing")).toBe(false);
    expect(removeWritableContext("staging")).toBe(true);

    mkdirSync(join(dir, "argocd-axi"), { recursive: true });
    writeFileSync(configPath(), "# existing comment\n");
    expect(addWritableContext("dev")).toBe(true);
    expect(readFileSync(configPath(), "utf8")).toContain("# existing comment");
    expect(loadConfig().config).toEqual({ writableContexts: ["dev"] });

    writeFileSync(configPath(), "---\n");
    expect(addWritableContext("prod")).toBe(true);
    expect(loadConfig().config).toEqual({ writableContexts: ["prod"] });
  });

  it("rejects malformed files loudly", () => {
    const bad = (text: string) => () => parseConfig("/x/config", text);
    expect(parseConfig("/x/config", "")).toEqual({ writableContexts: [] });
    expect(bad("writable-contexts: staging")).toThrow(/must be a list/);
    expect(bad("writable-contexts: ['*']")).toThrow(/not patterns/);
    expect(bad("other-setting: [a]")).toThrow(/unknown setting other-setting/);
    expect(bad("- a")).toThrow(/mapping/);
    expect(bad("writable-contexts: [1]")).toThrow(/non-empty context name/);
    expect(bad("a: [")).toThrow(/not valid YAML/);
  });
});

describe("write gate (decisions S3, S8, A7)", () => {
  const none = { writableContexts: [] };
  const staging = { writableContexts: ["staging"] };
  const request = { command: "apps sync", executeFlag: "--now" };

  it("requires an explicit context unless exactly one writable context exists", () => {
    for (const config of [none, { writableContexts: ["staging", "prod"] }]) {
      expect(() => evaluateWriteGate({ ...request, context: undefined, execute: false }, config))
        .toThrow(/needs --context.*writable contexts/);
    }
    expect(evaluateWriteGate({ ...request, context: undefined, execute: false }, staging))
      .toMatchObject({ mode: "preview", context: "staging", defaulted: true });
  });

  it("lets an explicit context override the sole writable default", () => {
    expect(evaluateWriteGate({ ...request, context: "prod", execute: false }, staging))
      .toMatchObject({ mode: "preview", context: "prod", defaulted: false });
  });

  it("previews by default, against any context", () => {
    expect(
      evaluateWriteGate({ ...request, context: "prod", execute: false }, none),
    ).toMatchObject({
      mode: "preview",
      context: "prod",
      writable: false,
    });
    expect(
      evaluateWriteGate(
        { ...request, context: "staging", execute: false },
        staging,
      ),
    ).toMatchObject({
      mode: "preview",
      writable: true,
      help: ["Re-run with --now to execute against staging"],
    });
  });

  it("executes only against allowlisted contexts", () => {
    expect(
      evaluateWriteGate(
        { ...request, context: "staging", execute: true },
        staging,
      ),
    ).toEqual({
      mode: "execute",
      context: "staging",
      defaulted: false,
    });
    expect(() =>
      evaluateWriteGate(
        { ...request, context: "prod", execute: true },
        staging,
      ),
    ).toThrow(/not listed in writable-contexts/);
    expect(() =>
      evaluateWriteGate(
        { ...request, context: "staging", execute: true },
        none,
      ),
    ).toThrow(/REFUSED|not listed/);
  });

  it("summarises the allowlist and carries the audit attribution", () => {
    expect(writableContextsSummary(none)).toBe("none");
    expect(writableContextsSummary({ writableContexts: ["a", "b"] })).toBe(
      "a, b",
    );
    expect(ATTRIBUTION_INFO).toBe("initiated-by=argocd-axi");
    expect(attributionArgs()).toEqual(["--info", "initiated-by=argocd-axi"]);
  });
});
