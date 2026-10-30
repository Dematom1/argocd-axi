/**
 * Secret redaction (design decision S12): values whose key looks sensitive
 * are replaced, the number of redacted fields is reported, and there is no
 * flag that reveals them. Pattern redaction is best effort for free text such
 * as log lines; structured data (Kubernetes Secrets, Helm parameters, env
 * vars) is redacted by structure.
 */

export const REDACTED = "[redacted]";

const SENSITIVE_KEY =
  /passw(?:or)?d|passwd|secret|token|api[-_.]?key|private[-_.]?key|credential|bearer|authorization|cookie|session[-_.]?id|access[-_.]?key|ssh[-_.]?key|tls[-_.]key|signing[-_.]?key|encryption[-_.]?key|jwt|webhook[-_.]?url|connection[-_.]?string|(?:^|[-_.])(?:auth|dsn|pat)$/i;

// Keys that name or point at a secret instead of holding one.
const REFERENCE_KEY =
  /secret[-_.]?name|secret[-_.]?ref|secretkeyref|existing[-_.]?secret|secret[-_.]?store|automountserviceaccounttoken|token[-_.]?url|auth[-_.]?url|token[-_.]?endpoint/i;

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) && !REFERENCE_KEY.test(key);
}

function isRedactableScalar(value: unknown): boolean {
  return (
    (typeof value === "string" && value.length > 0) || typeof value === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects redactions so a command can report how many fields it hid. */
export class Redactor {
  count = 0;

  /** Return a deep copy of `value` with sensitive values replaced. */
  deep<T>(value: T): T {
    return this.walk(value, false) as T;
  }

  text(value: string): string {
    const result = redactText(value);
    this.count += result.count;
    return result.text;
  }

  private replace(value: unknown): unknown {
    if (isRedactableScalar(value)) {
      this.count += 1;
      return REDACTED;
    }
    if (Array.isArray(value)) return value.map((entry) => this.replace(entry));
    if (isRecord(value)) return this.walk(value, true);
    return value;
  }

  private walk(value: unknown, underSensitiveKey: boolean): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) =>
        underSensitiveKey ? this.replace(entry) : this.walk(entry, false),
      );
    }
    if (!isRecord(value)) {
      if (underSensitiveKey) return this.replace(value);
      if (typeof value !== "string") return value;
      const count = { n: 0 };
      const masked = maskUserinfo(value, count);
      this.count += count.n;
      return masked;
    }

    const isSecret = value.kind === "Secret";
    const pairName = typeof value.name === "string" ? value.name : undefined;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSecret && (key === "data" || key === "stringData")) {
        out[key] = isRecord(entry)
          ? Object.fromEntries(
              Object.entries(entry).map(([k, v]) => [k, this.replace(v)]),
            )
          : this.replace(entry);
        continue;
      }
      if (isSecret && key === "metadata" && isRecord(entry)) {
        out[key] = this.redactSecretMetadata(entry);
        continue;
      }
      if (
        key === "value" &&
        pairName !== undefined &&
        isSensitiveKey(pairName)
      ) {
        out[key] = this.replace(entry);
        continue;
      }
      if (isSensitiveKey(key) && !isRecord(entry)) {
        out[key] = Array.isArray(entry)
          ? entry.map((item) => this.replace(item))
          : this.replace(entry);
        continue;
      }
      out[key] = this.walk(entry, false);
    }
    return out;
  }

  private redactSecretMetadata(
    metadata: Record<string, unknown>,
  ): Record<string, unknown> {
    const walked = this.walk(metadata, false) as Record<string, unknown>;
    const annotations = walked.annotations;
    if (isRecord(annotations) && LAST_APPLIED in annotations) {
      walked.annotations = {
        ...annotations,
        [LAST_APPLIED]: this.replace(annotations[LAST_APPLIED]),
      };
    }
    return walked;
  }
}

const KEY_VALUE =
  /(["']?)([A-Za-z0-9_.-]*?(?:passw(?:or)?d|passwd|secret|token|api[-_.]?key|private[-_.]?key|credential|access[-_.]?key|client[-_.]?secret)[A-Za-z0-9_.-]*)\1([ \t]*[:=][ \t]*)(["']?)([^\s"',;&]+)\4/gi;
const BEARER = /\b(bearer|basic)([ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const URL_USERINFO = /(:\/\/[^/\s:@]*:)([^@\s/]+)(@)/g;
const URL_TOKEN_USERINFO = /(\b(?:https?|oci):\/\/)([^/\s:@]+)(@)/gi;
// `- name: DB_PASSWORD` followed by `value: ...` (env vars, Helm parameters).
const PAIR_NAME = /\bname:[ \t]*["']?([A-Za-z0-9_.-]+)["']?[ \t]*$/;
const PAIR_VALUE = /^([^A-Za-z]*value:[ \t]*)(\S.*)$/;

function maskUserinfo(text: string, count: { n: number }): string {
  const mask = (match: string, head: string, secret: string, at: string) => {
    if (secret === REDACTED) return match;
    count.n += 1;
    return `${head}${REDACTED}${at}`;
  };
  return text.replace(URL_USERINFO, mask).replace(URL_TOKEN_USERINFO, mask);
}

function redactLine(line: string, count: { n: number }): string {
  let text = line.replace(JWT, () => {
    count.n += 1;
    return REDACTED;
  });
  text = text.replace(
    BEARER,
    (match, scheme: string, space: string, value: string) => {
      if (value === REDACTED) return match;
      count.n += 1;
      return `${scheme}${space}${REDACTED}`;
    },
  );
  text = maskUserinfo(text, count);
  if (!/passw|passwd|secret|token|api[-_.]?key|private[-_.]?key|credential|access[-_.]?key|client[-_.]?secret/i.test(text))
    return text;
  return text.replace(
    KEY_VALUE,
    (
      match,
      q1: string,
      key: string,
      sep: string,
      q2: string,
      value: string,
    ) => {
      if (REFERENCE_KEY.test(key) || value === REDACTED) return match;
      count.n += 1;
      return `${q1}${key}${q1}${sep}${q2}${REDACTED}${q2}`;
    },
  );
}

/** Best-effort, line-by-line redaction of free text (log lines, diff text). */
export function redactText(input: string): { text: string; count: number } {
  const count = { n: 0 };
  let sensitivePair = false;
  const lines = input.split("\n").map((line) => {
    if (sensitivePair) {
      sensitivePair = false;
      const value = line.match(PAIR_VALUE);
      if (value && value[2] !== REDACTED) {
        count.n += 1;
        return `${value[1]}${REDACTED}`;
      }
    }
    const name = line.match(PAIR_NAME);
    sensitivePair = name?.[1] !== undefined && isSensitiveKey(name[1]);
    return redactLine(line, count);
  });
  return { text: lines.join("\n"), count: count.n };
}

/** The `redacted:` line every command adds when it hid something. */
export function redactionNotice(count: number): string | undefined {
  if (count === 0) return undefined;
  return `${count} sensitive ${count === 1 ? "value" : "values"} hidden; no flag reveals them`;
}
