import {
  AxiError,
  exitCodeForError,
  runAxiCli,
  type AxiCliCommand,
} from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { refuse } from "./commands/common.js";
import { appsCommand } from "./commands/apps.js";
import { appsetsCommand } from "./commands/appsets.js";
import { canICommand, whoamiCommand } from "./commands/account.js";
import { ctxCommand } from "./commands/ctx.js";
import { homeCommand } from "./commands/home.js";
import { clustersCommand, reposCommand } from "./commands/inventory.js";
import { projectsCommand } from "./commands/projects.js";
import { setupCommand } from "./commands/setup.js";
import { DESCRIPTION, TOP_HELP } from "./help.js";
import { NATIVE_NOUNS, REFUSALS } from "./registry.js";
import { renderBlocks, renderHelp } from "./toon.js";
import { VERSION } from "./version.js";

function renderError(message: string, code: string, help: string[]): string {
  return `${renderBlocks([encode({ error: message, code }), renderHelp(help)])}\n`;
}

/** Structured errors on stdout with the help block formatted like output. */
export function formatError(error: unknown): {
  output: string;
  exitCode: number;
} {
  if (error instanceof AxiError) {
    return {
      output: renderError(error.message, error.code, error.suggestions),
      exitCode: exitCodeForError(error),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: renderError(`unexpected failure: ${message}`, "UNKNOWN", []),
    exitCode: 1,
  };
}

function renderUnknownCommand(command: string): string {
  const native = Object.hasOwn(NATIVE_NOUNS, command)
    ? NATIVE_NOUNS[command]
    : undefined;
  const help = native
    ? [
        `argocd-axi spells this \`${native}\`: run \`argocd-axi ${native === "--version" ? "--version" : `${native} --help`}\``,
      ]
    : ["Run `argocd-axi --help` to see available commands"];
  return renderError(`Unknown command: ${command}`, "VALIDATION_ERROR", help);
}

const refusalCommand =
  (key: string): AxiCliCommand<undefined> =>
  async () =>
    refuse(key);

const TOP_LEVEL_REFUSALS = Object.keys(REFUSALS).filter(
  (key) => !key.includes(" "),
);

export const COMMANDS: Record<string, AxiCliCommand<undefined>> = Object.assign(
  Object.create(null) as Record<string, AxiCliCommand<undefined>>,
  {
    ctx: ctxCommand,
    whoami: whoamiCommand,
    "can-i": canICommand,
    apps: appsCommand,
    projects: projectsCommand,
    appsets: appsetsCommand,
    repos: reposCommand,
    clusters: clustersCommand,
    setup: setupCommand,
    ...Object.fromEntries(
      TOP_LEVEL_REFUSALS.map((key) => [key, refusalCommand(key)]),
    ),
  },
);

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: TOP_HELP,
    home: homeCommand,
    commands: COMMANDS,
    formatError,
    renderUnknownCommand,
  });
}
