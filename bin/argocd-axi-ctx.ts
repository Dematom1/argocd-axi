#!/usr/bin/env node
// Dedicated SessionStart-hook entrypoint (decision S17). The SDK hook runner
// spawns a bare command with no arguments; pointing it here instead of at the
// networked home view guarantees ambient context never calls the server,
// never triggers an SSO refresh and never reads a credential.
import { ctxView } from "../src/commands/ctx.js";

try {
  process.stdout.write(`${await ctxView([])}\n`);
} catch {
  // Ambient context must never break session start; degrade to silence.
  process.exitCode = 0;
}
