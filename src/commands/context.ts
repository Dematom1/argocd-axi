import { realpathSync } from "node:fs";
import { parseArgs, type CommandSpec } from "../args.js";
import { CODES, axiError } from "../errors.js";
import { encodeObject } from "../toon.js";
import { finish } from "./common.js";
import {
  lastSession,
  recordSession,
  sessionText,
  summarizeTranscript,
} from "../sessionlog.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function directory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function display(summary: ReturnType<typeof lastSession>): string | undefined {
  return summary ? sessionText(summary) : undefined;
}

const CONTEXT_SPEC: CommandSpec = {
  path: "context",
  summary: "Show or record session memory",
  positionals: [{ name: "action", required: false, description: "end" }],
  flags: [],
  examples: ["argocd-axi context", "argocd-axi context end"],
};

export async function contextCommand(args: string[]): Promise<string> {
  const parsed = parseArgs(CONTEXT_SPEC, args);
  const sub = parsed.positionals[0];
  if (sub !== undefined && sub !== "end") {
    throw axiError("unknown context action", CODES.VALIDATION_ERROR, [
      "Run `argocd-axi context` or `argocd-axi context end`",
    ]);
  }
  if (sub !== "end") {
    const summary = display(lastSession(directory(process.cwd())));
    return finish([encodeObject({ last_session: summary })], undefined);
  }
  if (process.stdin.isTTY)
    throw axiError(
      "context end reads a SessionEnd hook payload on stdin",
      CODES.VALIDATION_ERROR,
      ["It runs from the hook installed by `argocd-axi setup hooks`"],
    );
  let payload: unknown;
  try {
    payload = JSON.parse(
      await new Promise<string>((resolve, reject) => {
        let text = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: string) => (text += chunk));
        process.stdin.on("end", () => resolve(text));
        process.stdin.on("error", reject);
      }),
    );
  } catch {
    return finish(
      [encodeObject({ recorded: "nothing - stdin is not a hook payload" })],
      undefined,
    );
  }
  if (!isRecord(payload) || typeof payload.transcript_path !== "string")
    return finish(
      [encodeObject({ recorded: "nothing - payload has no transcript_path" })],
      undefined,
    );
  let summary;
  try {
    summary = await summarizeTranscript(payload.transcript_path);
  } catch {
    return finish(
      [encodeObject({ recorded: "nothing - transcript could not be read" })],
      undefined,
    );
  }
  if (!summary)
    return finish(
      [
        encodeObject({
          recorded: "nothing - no argocd-axi commands this session",
        }),
      ],
      undefined,
    );
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  try {
    recordSession(directory(cwd), summary);
  } catch {
    return finish(
      [
        encodeObject({
          recorded: "nothing - session log could not be written",
        }),
      ],
      undefined,
    );
  }
  return finish([encodeObject({ recorded: sessionText(summary) })], undefined);
}
