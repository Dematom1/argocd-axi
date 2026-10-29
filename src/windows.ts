/**
 * Project sync windows: whether each window is active now and whether a sync
 * would be allowed, mirroring Argo CD's own evaluation (5-field cron or robfig
 * descriptor, Go duration, IANA time zone; `SyncWindows.CanSync`). `argocd proj windows list
 * -o json` returns only the window specs, so the active state is computed here.
 */

export interface SyncWindow {
  kind?: string;
  schedule?: string;
  duration?: string;
  applications?: string[];
  namespaces?: string[];
  clusters?: string[];
  manualSync?: boolean;
  timeZone?: string;
  description?: string;
}

interface CronField {
  values: Set<number>;
  star: boolean;
}

interface Cron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const DESCRIPTORS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function parseValue(
  token: string,
  names: string[] | undefined,
  offset: number,
): number {
  const lower = token.toLowerCase();
  const named = names?.indexOf(lower) ?? -1;
  if (named >= 0) return named + offset;
  if (!/^\d+$/.test(token)) throw new Error(`invalid cron value ${token}`);
  return Number(token);
}

function parseField(
  text: string,
  min: number,
  max: number,
  names?: string[],
  nameOffset = 0,
): CronField {
  const values = new Set<number>();
  const star = text.startsWith("*") || text.startsWith("?");
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0)
      throw new Error(`invalid cron step in ${part}`);
    let start: number;
    let end: number;
    if (range === "*" || range === "?") {
      start = min;
      end = max;
    } else if (range?.includes("-")) {
      const [a, b] = range.split("-");
      start = parseValue(a ?? "", names, nameOffset);
      end = parseValue(b ?? "", names, nameOffset);
    } else {
      start = parseValue(range ?? "", names, nameOffset);
      end = stepText === undefined ? start : max;
    }
    if (start < min || end > max || start > end) {
      throw new Error(`cron value out of range in ${part}`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return { values, star };
}

export function parseCron(expression: string): Cron {
  const trimmed = expression.trim();
  const fields = (DESCRIPTORS[trimmed.toLowerCase()] ?? trimmed).split(/\s+/);
  if (fields.length !== 5)
    throw new Error(`expected 5 cron fields, got ${fields.length}`);
  const [minute, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const dowField = parseField(dow, 0, 7, DAYS);
  if (dowField.values.has(7)) {
    dowField.values.delete(7);
    dowField.values.add(0);
  }
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12, MONTHS, 1),
    dow: dowField,
  };
}

/** Parse a Go duration such as `1h`, `30m` or `1h30m` into milliseconds. */
export function parseGoDuration(text: string): number {
  const pattern = /(\d+(?:\.\d+)?)(h|m|s)/g;
  if (!/^(?:\d+(?:\.\d+)?(?:h|m|s))+$/.test(text))
    throw new Error(`invalid duration ${text}`);
  let ms = 0;
  for (const match of text.matchAll(pattern)) {
    const unit = { h: 3_600_000, m: 60_000, s: 1_000 }[
      match[2] as "h" | "m" | "s"
    ];
    ms += Number(match[1]) * unit;
  }
  return ms;
}

interface LocalTime {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localTime(instant: number, timeZone: string): LocalTime {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant))
    parts[part.type] = part.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dom: Number(parts.day),
    month: Number(parts.month),
    dow: DAYS.indexOf((parts.weekday ?? "").toLowerCase().slice(0, 3)),
  };
}

function matches(cron: Cron, t: LocalTime): boolean {
  if (!cron.minute.values.has(t.minute) || !cron.hour.values.has(t.hour))
    return false;
  if (!cron.month.values.has(t.month)) return false;
  const domMatch = cron.dom.values.has(t.dom);
  const dowMatch = cron.dow.values.has(t.dow);
  // robfig/cron semantics: when either day field is a wildcard both must
  // match; when both are restricted, either may match.
  return cron.dom.star || cron.dow.star
    ? domMatch && dowMatch
    : domMatch || dowMatch;
}

const MINUTE = 60_000;
const LOOKAHEAD_MS = 31 * 24 * 60 * MINUTE;

export interface WindowState {
  active: boolean;
  /** Next start time when inactive and a start falls within 31 days. */
  nextStart?: number;
  error?: string;
}

const EVERY = /^@every\s+(\S+)$/i;

/**
 * Argo CD treats a window as active when a cron fire falls in
 * (now - duration, now). For `@every <interval>` the next fire after
 * now - duration is always interval later, so the window is active exactly
 * when the interval is shorter than the duration.
 */
export function windowState(window: SyncWindow, now: number): WindowState {
  let cron: Cron;
  let durationMs: number;
  try {
    durationMs = parseGoDuration(window.duration ?? "");
    const every = (window.schedule ?? "").trim().match(EVERY);
    if (every) {
      return { active: parseGoDuration(every[1] as string) < durationMs };
    }
    cron = parseCron(window.schedule ?? "");
  } catch (error) {
    return { active: false, error: (error as Error).message };
  }
  const timeZone = window.timeZone || "UTC";
  try {
    localTime(now, timeZone);
  } catch {
    return { active: false, error: `unknown time zone ${timeZone}` };
  }

  const first = Math.floor((now - durationMs) / MINUTE) * MINUTE + MINUTE;
  for (let t = first; t < now; t += MINUTE) {
    if (matches(cron, localTime(t, timeZone))) return { active: true };
  }
  const nextFirst = Math.floor(now / MINUTE) * MINUTE + MINUTE;
  for (let t = nextFirst; t < now + LOOKAHEAD_MS; t += MINUTE) {
    if (matches(cron, localTime(t, timeZone)))
      return { active: false, nextStart: t };
  }
  return { active: false };
}

export type Verdict = "allowed" | "blocked" | "unknown";

export interface SyncVerdict {
  automated: Verdict;
  manual: Verdict;
  reason: string;
}

function unparsedReason(
  states: Array<{ window: SyncWindow; state: WindowState }>,
): string {
  return states
    .map(
      (s) =>
        `${s.window.kind ?? "unknown"} window ${JSON.stringify(s.window.schedule ?? "")} could not be evaluated (${s.state.error})`,
    )
    .join("; ");
}

/**
 * Mirror of Argo CD's `SyncWindows.CanSync` for automated and manual syncs.
 * A window that cannot be evaluated makes the verdict unknown wherever it
 * could change the outcome.
 */
export function syncVerdict(windows: SyncWindow[], now: number): SyncVerdict {
  if (windows.length === 0) {
    return {
      automated: "allowed",
      manual: "allowed",
      reason: "no sync windows",
    };
  }
  const states = windows.map((w) => ({
    window: w,
    state: windowState(w, now),
  }));
  const unparsed = states.filter((s) => s.state.error !== undefined);
  const activeDeny = states.filter(
    (s) => s.state.active && s.window.kind === "deny",
  );
  if (activeDeny.length > 0) {
    const reason = `${activeDeny.length} deny ${activeDeny.length === 1 ? "window is" : "windows are"} active`;
    if (activeDeny.some((s) => s.window.manualSync !== true)) {
      return { automated: "blocked", manual: "blocked", reason };
    }
    const doubtful = unparsed.filter(
      (s) => s.window.kind === "deny" && s.window.manualSync !== true,
    );
    return doubtful.length > 0
      ? {
          automated: "blocked",
          manual: "unknown",
          reason: `${reason}; ${unparsedReason(doubtful)}`,
        }
      : { automated: "blocked", manual: "allowed", reason };
  }
  const activeAllow = states.some(
    (s) => s.state.active && s.window.kind === "allow",
  );
  const doubtful = activeAllow
    ? unparsed.filter((s) => s.window.kind === "deny")
    : unparsed;
  if (doubtful.length > 0) {
    return {
      automated: "unknown",
      manual: "unknown",
      reason: unparsedReason(doubtful),
    };
  }
  if (activeAllow) {
    return {
      automated: "allowed",
      manual: "allowed",
      reason: "an allow window is active",
    };
  }
  const inactiveAllows = states.filter((s) => s.window.kind === "allow");
  if (inactiveAllows.length > 0) {
    return {
      automated: "blocked",
      manual: inactiveAllows.some((s) => s.window.manualSync === true)
        ? "allowed"
        : "blocked",
      reason: "allow windows exist but none is active",
    };
  }
  return {
    automated: "allowed",
    manual: "allowed",
    reason: "no window is active",
  };
}
