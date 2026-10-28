// Answers argocd invocations from a scenario file. See test/helpers.ts.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const scenarioPath = process.env.FAKE_ARGOCD_SCENARIO;
const logPath = process.env.FAKE_ARGOCD_LOG;

if (logPath) appendFileSync(logPath, `${JSON.stringify(argv)}\n`);

function fail(message) {
  process.stderr.write(
    `time="2026-01-01T00:00:00Z" level=fatal msg="fake argocd: ${message}"\n`,
  );
  process.exit(20);
}

if (!scenarioPath) fail("FAKE_ARGOCD_SCENARIO is not set");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const base = dirname(scenarioPath);

// Pull out --argocd-context so responses can be scoped to a context.
let context;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--argocd-context") {
    context = argv[++i];
    continue;
  }
  rest.push(argv[i]);
}

function matches(response) {
  if (response.context !== undefined && response.context !== (context ?? null))
    return false;
  const prefix = response.argv;
  if (prefix.length > rest.length) return false;
  if (!prefix.every((token, i) => rest[i] === token)) return false;
  if (response.exact && prefix.length !== rest.length) return false;
  return (response.contains ?? []).every((token) => rest.includes(token));
}

const candidates = scenario.responses.filter(matches);
candidates.sort(
  (a, b) =>
    b.argv.length +
    (b.contains?.length ?? 0) +
    (b.context !== undefined ? 1 : 0) -
    (a.argv.length +
      (a.contains?.length ?? 0) +
      (a.context !== undefined ? 1 : 0)),
);
const response = candidates[0];
if (!response) fail(`no fixture for ${JSON.stringify(rest)}`);

// Timestamps in fixtures may be written relative to now, e.g. {{now-25m}}.
function relativeTimes(text) {
  return text.replace(/\{\{now(?:-(\d+)([smhd]))?\}\}/g, (_m, n, unit) => {
    const ms = n
      ? Number(n) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[unit]
      : 0;
    return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  });
}

function load(file) {
  return relativeTimes(readFileSync(resolve(base, file), "utf8"));
}

let stdout = response.stdout ?? "";
if (response.stdoutFile) stdout = load(response.stdoutFile);
if (response.jsonArrayOf) {
  stdout = JSON.stringify(
    response.jsonArrayOf.map((file) => JSON.parse(load(file))),
  );
}

const finish = () => {
  if (stdout) process.stdout.write(relativeTimes(stdout));
  if (response.stderr) process.stderr.write(response.stderr);
  process.exit(response.exit ?? 0);
};
if (response.delayMs) setTimeout(finish, response.delayMs);
else finish();
