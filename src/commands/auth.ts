import { parseArgs, CONTEXT_FLAG, type CommandSpec } from "../args.js";
import { describeTarget, listContexts, resolveTarget } from "../context.js";
import { validationError } from "../errors.js";
import { encodeObject } from "../toon.js";
import { contextOption, finish } from "./common.js";

const GUIDE_SPEC: CommandSpec = {
  path: "auth guide",
  summary: "Offline setup instructions for human and agent credentials",
  positionals: [],
  flags: [CONTEXT_FLAG],
  examples: ["argocd-axi auth guide", "argocd-axi auth guide --context prod"],
};

export async function authCommand(args: string[]): Promise<string> {
  if (args[0] !== "guide") throw validationError("expected auth guide");
  const parsed = parseArgs(GUIDE_SPEC, args.slice(1));
  const explicitContext = contextOption(parsed).context;
  let listing: Awaited<ReturnType<typeof listContexts>>;
  try {
    listing = await listContexts();
  } catch {
    listing = { contexts: [], unavailable: "argocd could not list contexts" };
  }
  const { target } = await resolveTarget(explicitContext, listing);
  const server = target.envServer ?? target.server;
  const login = server
    ? `argocd login '${server.replaceAll("'", "'\\''")}' --sso --grpc-web`
    : undefined;
  return finish(
    [
      encodeObject({
        ...describeTarget(target, listing),
        operator:
          "Run the interactive command yourself; argocd-axi never logs in",
        login,
        agent:
          "Set ARGOCD_SERVER and ARGOCD_AUTH_TOKEN using a scoped Argo CD account token",
        verify: "Run `argocd-axi ctx`",
      }),
    ],
    undefined,
    login
      ? []
      : ["Run `argocd-axi ctx` to identify the server for the login command"],
  );
}
