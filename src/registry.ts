/**
 * The allowlist registry (design decision S5). These are the only argocd
 * invocations the subprocess seam in `argocd.ts` can make. Every entry is a
 * server read or a local-config operation; nothing here can change an Argo CD
 * server or cluster. A test pins this table, so adding an operation is a
 * deliberate, reviewed change.
 */

export type Tier =
  /** Reads Argo CD server state. */
  | "read"
  /** Reads only the local argocd CLI config or binary; no network. */
  | "local"
  /** Changes only the local argocd CLI config (`ctx use`, decision A11). */
  | "local-write"
  /** Changes one Application in Argo CD. */
  | "write";

export interface Operation {
  argv: readonly string[];
  tier: Tier;
  network: boolean;
  /** Hard subprocess timeout; `apps wait` passes its own. */
  timeoutMs: number;
}

const READ_TIMEOUT_MS = 60_000;
const LOCAL_TIMEOUT_MS = 10_000;

export const OPERATIONS = {
  "app list": {
    argv: ["app", "list"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app get": {
    argv: ["app", "get"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app diff": {
    argv: ["app", "diff"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app sync": {
    argv: ["app", "sync"],
    tier: "write",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app rollback": {
    argv: ["app", "rollback"],
    tier: "write",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app terminate-op": {
    argv: ["app", "terminate-op"],
    tier: "write",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app refresh": {
    argv: ["app", "get"],
    tier: "write",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app resources": {
    argv: ["app", "resources"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app manifests": {
    argv: ["app", "manifests"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app logs": {
    argv: ["app", "logs"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app wait": {
    argv: ["app", "wait"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "app actions list": {
    argv: ["app", "actions", "list"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "proj list": {
    argv: ["proj", "list"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "proj get": {
    argv: ["proj", "get"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "proj windows list": {
    argv: ["proj", "windows", "list"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "appset list": {
    argv: ["appset", "list"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "appset get": {
    argv: ["appset", "get"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "appset generate": {
    argv: ["appset", "generate"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "repo list": {
    argv: ["repo", "list"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "cluster list": {
    argv: ["cluster", "list"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "account get-user-info": {
    argv: ["account", "get-user-info"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "account can-i": {
    argv: ["account", "can-i"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  version: {
    argv: ["version"],
    tier: "read",
    network: true,
    timeoutMs: READ_TIMEOUT_MS,
  },
  "version client": {
    argv: ["version", "--client"],
    tier: "local",
    network: false,
    timeoutMs: LOCAL_TIMEOUT_MS,
  },
  "context list": {
    argv: ["context"],
    tier: "local",
    network: false,
    timeoutMs: LOCAL_TIMEOUT_MS,
  },
  "context use": {
    argv: ["context"],
    tier: "local-write",
    network: false,
    timeoutMs: LOCAL_TIMEOUT_MS,
  },
} as const satisfies Record<string, Operation>;

export type OperationId = keyof typeof OPERATIONS;

/**
 * Arguments the seam refuses whatever the caller passes: streaming, prompts,
 * reconcile triggers, local-file inputs and anything that deletes. This is a
 * second line of defence behind the per-command flag allowlists.
 */
export const FORBIDDEN_ARGS: readonly string[] = [
  "-f",
  "--follow",
  "--watch",
  "--refresh",
  "--hard-refresh",
  "--preview-changes",
  "-y",
  "--yes",
  "--assumeYes",
  "--delete",
  "--local",
  "--local-repo-root",
  "--server-side-generate",
  "--auth-token",
  "--config",
  "--core",
  "--port-forward",
  "--prompts-enabled",
];

export interface Refusal {
  reason: string;
  help: string[];
}

const PLANNED =
  "planned for the write tier, behind preview-by-default and the writable-contexts allowlist; not in v1 (see ROADMAP.md)";

/**
 * Writes the design names for the next tier (decision A2): known verbs that
 * answer REFUSED with the raw argocd route a human can take today.
 */
export const PLANNED_WRITES: Record<string, Refusal> = {
  "apps action": {
    reason: `running resource actions is ${PLANNED}`,
    help: [
      "List available actions with `argocd-axi apps actions <app>`",
      "A human can run one with the raw CLI: `argocd app actions run <app> <action> --kind <kind>`",
    ],
  },
};

const HUMAN_ONLY = "A human runs this with the raw argocd CLI";

/**
 * Known verbs that argocd-axi never wraps (design decisions S7 and A2), each
 * with the reason and the human route. Keyed by the argocd-axi spelling.
 */
export const REFUSALS: Record<string, Refusal> = {
  login: {
    reason:
      "not wrapped - logging in is interactive (browser SSO or a password prompt), and argocd-axi never prompts",
    help: [`${HUMAN_ONLY}: \`argocd login <server> --sso\``],
  },
  relogin: {
    reason:
      "not wrapped - re-authenticating is interactive, and argocd-axi never prompts",
    help: [`${HUMAN_ONLY}: \`argocd relogin\``],
  },
  logout: {
    reason:
      "not wrapped - argocd-axi never writes, rotates or erases a credential",
    help: [`${HUMAN_ONLY}: \`argocd logout <context>\``],
  },
  configure: {
    reason: "not wrapped - argocd-axi does not change argocd CLI settings",
    help: [`${HUMAN_ONLY}: \`argocd configure\``],
  },
  account: {
    reason:
      "not wrapped - account commands mint tokens or change passwords, and argocd-axi never prints or changes a credential",
    help: [
      "Run `argocd-axi whoami` to see the current user",
      "Run `argocd-axi can-i <action> <resource> <object>` to check permissions",
    ],
  },
  "projects role": {
    reason:
      "not wrapped - project roles mint tokens (create-token) and change RBAC policy",
    help: [
      "Run `argocd-axi projects view <project>` to read a project's roles",
      `${HUMAN_ONLY}: \`argocd proj role ...\``,
    ],
  },
  repocreds: {
    reason: "not wrapped - repository credential templates hold secrets",
    help: [
      "Run `argocd-axi repos` to list repositories and their connection status",
    ],
  },
  "repos add": {
    reason: "not wrapped - adding a repository stores credentials",
    help: [`${HUMAN_ONLY}: \`argocd repo add <url> ...\``],
  },
  "repos rm": {
    reason: "not wrapped - removing a repository is a write",
    help: [`${HUMAN_ONLY}: \`argocd repo rm <url>\``],
  },
  "clusters add": {
    reason:
      "not wrapped - adding a cluster reads your kubeconfig and stores cluster credentials",
    help: [`${HUMAN_ONLY}: \`argocd cluster add <kube-context>\``],
  },
  "clusters rm": {
    reason: "not wrapped - removing a cluster is a write",
    help: [`${HUMAN_ONLY}: \`argocd cluster rm <server>\``],
  },
  "clusters set": {
    reason: "not wrapped - changing a cluster is a write",
    help: [`${HUMAN_ONLY}: \`argocd cluster set <name> ...\``],
  },
  "clusters rotate-auth": {
    reason: "not wrapped - rotating cluster credentials is a credential write",
    help: [`${HUMAN_ONLY}: \`argocd cluster rotate-auth <server>\``],
  },
  cert: {
    reason:
      "not wrapped - certificate commands change trusted TLS and SSH material",
    help: [`${HUMAN_ONLY}: \`argocd cert ...\``],
  },
  gpg: {
    reason: "not wrapped - GPG key commands change trusted signing keys",
    help: [`${HUMAN_ONLY}: \`argocd gpg ...\``],
  },
  admin: {
    reason:
      "not wrapped - admin commands need direct cluster access and can export or overwrite all Argo CD data, including secrets",
    help: [`${HUMAN_ONLY}: \`argocd admin ...\``],
  },
  "apps edit": {
    reason:
      "not wrapped - edit opens an interactive editor, and Git is the source of truth for an app spec",
    help: ["Change the app's manifests or Application spec in Git instead"],
  },
  "apps delete": {
    reason:
      "not wrapped - deleting an app can cascade-delete its cluster resources",
    help: [`${HUMAN_ONLY}: \`argocd app delete <app>\``],
  },
  "apps delete-resource": {
    reason: "not wrapped - deletes a live Kubernetes resource",
    help: [`${HUMAN_ONLY}: \`argocd app delete-resource <app> ...\``],
  },
  "apps patch-resource": {
    reason: "not wrapped - patches a live Kubernetes resource outside Git",
    help: [`${HUMAN_ONLY}: \`argocd app patch-resource <app> ...\``],
  },
  "apps create": {
    reason: "not wrapped - Application specs belong in Git",
    help: [`${HUMAN_ONLY}: \`argocd app create ...\``],
  },
  "apps set": {
    reason: "not wrapped - changes the Application spec outside Git",
    help: [`${HUMAN_ONLY}: \`argocd app set <app> ...\``],
  },
  "apps unset": {
    reason: "not wrapped - changes the Application spec outside Git",
    help: [`${HUMAN_ONLY}: \`argocd app unset <app> ...\``],
  },
  "apps patch": {
    reason: "not wrapped - changes the Application spec outside Git",
    help: [`${HUMAN_ONLY}: \`argocd app patch <app> ...\``],
  },
  "projects create": {
    reason: "not wrapped - creating a project is a write",
    help: [`${HUMAN_ONLY}: \`argocd proj create <project>\``],
  },
  "projects delete": {
    reason: "not wrapped - deleting a project is destructive",
    help: [`${HUMAN_ONLY}: \`argocd proj delete <project>\``],
  },
  "projects edit": {
    reason: "not wrapped - edit opens an interactive editor",
    help: [`${HUMAN_ONLY}: \`argocd proj edit <project>\``],
  },
  "projects set": {
    reason: "not wrapped - changing a project is a write",
    help: [`${HUMAN_ONLY}: \`argocd proj set <project> ...\``],
  },
  "appsets create": {
    reason: "not wrapped - creating an ApplicationSet is a write",
    help: [
      "Preview what a spec would generate with `argocd-axi appsets generate <file>`",
    ],
  },
  "appsets delete": {
    reason:
      "not wrapped - deleting an ApplicationSet can delete every app it generated",
    help: [`${HUMAN_ONLY}: \`argocd appset delete <name>\``],
  },
};

/**
 * argocd's own nouns, so `argocd-axi app list` points at the argocd-axi
 * spelling instead of failing blind.
 */
export const NATIVE_NOUNS: Record<string, string> = {
  app: "apps",
  application: "apps",
  applications: "apps",
  proj: "projects",
  project: "projects",
  appset: "appsets",
  applicationset: "appsets",
  repo: "repos",
  cluster: "clusters",
  context: "ctx",
  version: "--version",
};
