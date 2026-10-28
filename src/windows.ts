/**
 * Project sync windows: whether each window is active now and whether a sync
 * would be allowed, mirroring Argo CD's own evaluation (5-field cron, Go
 * duration, IANA time zone; `SyncWindows.CanSync`). `argocd proj windows list
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
  const fields = expression.trim().split(/\s+/);
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

/**
 * Argo CD treats a window as active when a cron fire falls in
 * (now - duration, now).
 */
export function windowState(window: SyncWindow, now: number): WindowState {
  let cron: Cron;
  let durationMs: number;
  try {
    cron = parseCron(window.schedule ?? "");
    durationMs = parseGoDuration(window.duration ?? "");
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

export interface SyncVerdict {
  automated: boolean;
  manual: boolean;
  reason: string;
}

/** Mirror of Argo CD's `SyncWindows.CanSync` for automated and manual syncs. */
export function syncVerdict(windows: SyncWindow[], now: number): SyncVerdict {
  if (windows.length === 0) {
    return { automated: true, manual: true, reason: "no sync windows" };
  }
  const states = windows.map((w) => ({
    window: w,
    state: windowState(w, now),
  }));
  const activeDeny = states.filter(
    (s) => s.state.active && s.window.kind === "deny",
  );
  if (activeDeny.length > 0) {
    const manual = activeDeny.every((s) => s.window.manualSync === true);
    return {
      automated: false,
      manual,
      reason: `${activeDeny.length} deny ${activeDeny.length === 1 ? "window is" : "windows are"} active`,
    };
  }
  if (states.some((s) => s.state.active && s.window.kind === "allow")) {
    return {
      automated: true,
      manual: true,
      reason: "an allow window is active",
    };
  }
  const inactiveAllows = states.filter((s) => s.window.kind === "allow");
  if (inactiveAllows.length > 0) {
    return {
      automated: false,
      manual: inactiveAllows.some((s) => s.window.manualSync === true),
      reason: "allow windows exist but none is active",
    };
  }
  return { automated: true, manual: true, reason: "no window is active" };
}
