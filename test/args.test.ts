import { describe, expect, it } from "vitest";
import {
  getInt,
  getList,
  parseArgs,
  parseDurationSeconds,
  validateName,
  type CommandSpec,
} from "../src/args.js";

const spec: CommandSpec = {
  path: "apps logs",
  summary: "test",
  positionals: [{ name: "app", required: true, description: "app" }],
  flags: [
    { name: "--tail", kind: "value", description: "lines" },
    { name: "--previous", short: "-p", kind: "bool", description: "previous" },
    { name: "--project", kind: "multi", description: "projects" },
  ],
  examples: ["argocd-axi apps logs guestbook"],
};

describe("flag parsing (AXI principle 6)", () => {
  it("accepts both --flag value and --flag=value, short aliases and repeatable lists", () => {
    const parsed = parseArgs(spec, [
      "guestbook",
      "--tail=50",
      "-p",
      "--project",
      "a,b",
      "--project",
      "c",
    ]);
    expect(parsed.positionals).toEqual(["guestbook"]);
    expect(getInt(parsed, "--tail", { default: 100, min: 1, max: 5000 })).toBe(
      50,
    );
    expect(getList(parsed, "--project")).toEqual(["a", "b", "c"]);
    expect(parsed.flags.get("--previous")).toBe(true);
  });

  it("rejects unknown flags with the valid set and a targeted hint", () => {
    try {
      parseArgs(spec, ["guestbook", "--follow"]);
      expect.unreachable();
    } catch (error) {
      const e = error as {
        code: string;
        message: string;
        suggestions: string[];
      };
      expect(e.code).toBe("VALIDATION_ERROR");
      expect(e.message).toBe("unknown flag --follow for `apps logs`");
      expect(e.suggestions[0]).toMatch(/never streams/);
      expect(e.suggestions[1]).toMatch(
        /valid flags for `apps logs`: --tail <value>, -p, --previous/,
      );
    }
    expect(() => parseArgs(spec, ["guestbook", "--json"])).toThrow(
      /unknown flag --json/,
    );
  });

  it("rejects missing values, repeated single flags, values on booleans and extra arguments", () => {
    expect(() => parseArgs(spec, ["guestbook", "--tail"])).toThrow(
      /--tail needs a value/,
    );
    expect(() =>
      parseArgs(spec, ["guestbook", "--tail", "1", "--tail", "2"]),
    ).toThrow(/more than once/);
    expect(() => parseArgs(spec, ["guestbook", "--previous=yes"])).toThrow(
      /takes no value/,
    );
    expect(() => parseArgs(spec, ["guestbook", "extra"])).toThrow(
      /unexpected argument extra/,
    );
    expect(() => parseArgs(spec, [])).toThrow(/missing <app>/);
  });

  it("validates numbers, durations and names", () => {
    expect(() =>
      getInt(parseArgs(spec, ["a", "--tail", "x"]), "--tail", {
        default: 1,
        min: 1,
        max: 5,
      }),
    ).toThrow(/whole number/);
    expect(() =>
      getInt(parseArgs(spec, ["a", "--tail", "9"]), "--tail", {
        default: 1,
        min: 1,
        max: 5,
      }),
    ).toThrow(/between 1 and 5/);
    expect(parseDurationSeconds("--since", "15m")).toBe(900);
    expect(parseDurationSeconds("--since", "2h")).toBe(7200);
    expect(() => parseDurationSeconds("--since", "15 minutes")).toThrow(
      /30s, 15m/,
    );
    expect(validateName("app", "team-a/billing")).toBe("team-a/billing");
    expect(() => validateName("app", "Bad_Name")).toThrow(/invalid app name/);
    expect(() => validateName("app", "a/b/c")).toThrow(/invalid app name/);
  });
});
