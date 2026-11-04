// Synthetic protocol lab only: packed argocd-axi + real argocd, no real Argo CD.
// Run: node test/native-sync-lab.mjs /absolute/path/to/unpacked/package
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(process.argv[2]);
const home = mkdtempSync(join(tmpdir(), "argocd-sync-lab-"));
const calls = [];
let running = false;
let synced = false;
let rejectSync = "";
function vi(n) {
  const bytes = [];
  do {
    const b = n & 127;
    n = Math.floor(n / 128);
    bytes.push(b | (n ? 128 : 0));
  } while (n);
  return Buffer.from(bytes);
}
function field(n, value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([vi(n * 8 + 2), vi(b.length), b]);
}
function frame(payload, trailer = false) {
  const head = Buffer.alloc(5);
  head[0] = trailer ? 128 : 0;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
function app() {
  return Buffer.concat([
    field(1, field(1, "proof")),
    field(2, Buffer.concat([field(1, field(4, "main")), field(3, "default")])),
    field(
      3,
      Buffer.concat([
        field(
          2,
          Buffer.concat([
            field(1, synced ? "Synced" : "OutOfSync"),
            field(3, "abc1234"),
          ]),
        ),
        field(3, field(1, "Healthy")),
        ...(running ? [field(7, field(2, "Running"))] : []),
      ]),
    ),
    ...(running ? [field(4, Buffer.alloc(0))] : []),
  ]);
}
const server = createServer(async (req, res) => {
  let body = Buffer.alloc(0);
  for await (const chunk of req) body = Buffer.concat([body, chunk]);
  const route = req.url;
  calls.push({ route, bytes: body.toString("hex") });
  const reply = (payload = Buffer.alloc(0), code = 0, message = "") => {
    res.writeHead(200, {
      "content-type": "application/grpc-web+proto",
      "grpc-status": String(code),
      ...(message ? { "grpc-message": message } : {}),
    });
    res.end(
      Buffer.concat([
        ...(code ? [] : [frame(payload)]),
        frame(
          Buffer.from(
            `grpc-status: ${code}\r\n${message ? `grpc-message: ${message}\r\n` : ""}`,
          ),
          true,
        ),
      ]),
    );
  };
  if (route.endsWith("/CanI")) return reply(field(1, "yes"));
  if (route === "/application.ApplicationService/Get") return reply(app());
  if (route === "/project.ProjectService/Get") return reply();
  if (route === "/cluster.SettingsService/Get") return reply();
  if (route === "/application.ApplicationService/Sync") {
    if (rejectSync) return reply(Buffer.alloc(0), 9, rejectSync);
    running = true;
    return reply(app());
  }
  if (route === "/application.ApplicationService/TerminateOperation")
    return reply();
  if (route === "/application.ApplicationService/Watch") {
    res.writeHead(200, { "content-type": "application/grpc-web+proto" });
    res.write(frame(Buffer.concat([field(1, "MODIFIED"), field(2, app())])));
    // Keep Running forever: only apps wait may subscribe, bounded by its timeout.
    return;
  }
  return reply(Buffer.alloc(0), 12, `unsupported synthetic RPC ${route}`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const target = `127.0.0.1:${server.address().port}`;
for (const name of ["argocd", "argocd-axi"])
  mkdirSync(join(home, ".config", name), { recursive: true });
writeFileSync(
  join(home, ".config", "argocd", "config"),
  JSON.stringify({
    "current-context": "proof",
    contexts: [{ name: "proof", server: target, user: "synthetic" }],
    servers: [{ server: target, plaintext: true, "grpc-web": true }],
    users: [{ name: "synthetic" }],
  }),
  { mode: 0o600 },
);
writeFileSync(
  join(home, ".config", "argocd-axi", "config"),
  "writable-contexts: [proof]\n",
);
async function run(args, observe) {
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [join(root, "dist/bin/argocd-axi.js"), ...args, "--context", "proof"],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        ARGOCD_SERVER: target,
        ARGOCD_AUTH_TOKEN: "synthetic-token",
        ARGOCD_OPTS: "--plaintext --grpc-web",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 25_000,
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
    observe?.(stderr, Date.now() - started);
  });
  const code = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  return { code, stdout, stderr, elapsed: Date.now() - started };
}
try {
  let start = calls.length;
  let result = await run(["apps", "sync", "proof", "--confirm"]);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.match(result.stdout, /sync: started/);
  assert.match(result.stdout, /revision: main/);
  assert.match(result.stdout, /apps view proof --context proof/);
  assert.match(result.stdout, /apps wait proof --context proof/);
  assert(running, "operation must still be running when sync exits");
  assert(calls.slice(start).some((c) => c.route.endsWith("/Sync")));
  assert(!calls.slice(start).some((c) => c.route.endsWith("/Watch")));
  assert(calls.at(-1).route.endsWith("/Sync"), "no post-write read");
  result = await run(["apps", "sync", "proof", "--confirm"]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /sync: already running/);
  running = false;
  rejectSync = "another operation is already in progress";
  result = await run(["apps", "sync", "proof", "--confirm"]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /sync: already running/);
  rejectSync = "SyncWindow blocks this application";
  result = await run(["apps", "sync", "proof", "--confirm"]);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /REFUSED/);
  rejectSync = "";
  running = true;
  start = calls.length;
  result = await run(["apps", "terminate-op", "proof", "--confirm"]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /terminateOperation: submitted/);
  assert(!calls.slice(start).some((c) => c.route.endsWith("/Watch")));
  let progressBeforeExit = false;
  result = await run(
    ["apps", "wait", "proof", "--operation", "--timeout", "6"],
    (text) => {
      if (text.includes("0s elapsed")) progressBeforeExit = true;
    },
  );
  assert.equal(result.code, 1, JSON.stringify(result));
  assert(progressBeforeExit);
  assert.match(result.stderr, /5s elapsed/);
  assert.match(result.stdout, /timed out after 6s/);
  assert(!result.stdout.includes("Waiting for"));
  running = false;
  synced = true;
  start = calls.length;
  result = await run(["apps", "sync", "proof", "--confirm"]);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.match(result.stdout, /sync: already synced/);
  assert(!calls.slice(start).some((c) => c.route.endsWith("/Sync")));
  result = await run([
    "apps",
    "wait",
    "proof",
    "--operation",
    "--timeout",
    "2",
  ]);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.match(result.stdout, /condition met/);
  for (const hard of [false, true]) {
    result = await run([
      "apps",
      "refresh",
      "proof",
      "--confirm",
      ...(hard ? ["--hard"] : []),
    ]);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.match(result.stderr, /Waiting for refresh/);
  }
  console.log(
    "PASS synthetic protocol lab: packed package + real argocd; no real Argo CD. Async acceptance while Running, existing operation, submission race, refusal, nonblocking termination, timed-out and completed wait, stderr heartbeat, refresh progress.",
  );
  console.log(JSON.stringify({ calls }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  rmSync(home, { recursive: true, force: true });
}
