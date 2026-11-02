import { parseArgs, CONTEXT_FLAG, type CommandSpec } from "../args.js";
import {
  describeTarget,
  listContexts,
  resolveTarget,
  tokenExpiry,
} from "../context.js";
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
  } catch (error) {
    listing = {
      contexts: [],
      unavailable: error instanceof Error ? error.message : String(error),
    };
  }
  const { target } = await resolveTarget(explicitContext, listing);
  const server = target.envServer ?? target.server;
  const login = server
    ? `argocd login '${server.replaceAll("'", "'\\''")}' --sso --grpc-web`
    : "argocd login <server> --sso --grpc-web";
  return finish(
    [
      encodeObject({
        ...describeTarget(target, listing),
        contexts: listing.unavailable
          ? `unavailable - ${listing.unavailable}`
          : undefined,
        tokenExpiry: tokenExpiry(),
        operator: target.envToken
          ? "Replace ARGOCD_AUTH_TOKEN to rotate credentials; no SSO or CLI-session fallback"
          : "Run the interactive command yourself; argocd-axi never logs in",
        login: target.envToken ? undefined : login,
        agent:
          "Set ARGOCD_SERVER and ARGOCD_AUTH_TOKEN using a scoped Argo CD account token",
        verify: "Run `argocd-axi ctx`",
      }),
    ],
    undefined,
    server
      ? []
      : [
          "Obtain the Argo CD server address, then replace `<server>` in the login command",
        ],
  );
}
