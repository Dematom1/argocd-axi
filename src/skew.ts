import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argocdJson } from "./argocd.js";

/**
 * CLI and server version skew (design decision A10). The server version is
 * checked by the networked home view without persisting state. Existing
 * version caches remain readable by the offline `ctx` view. There is no hard minimum version; a major
 * version difference is a warning, never an error.
 */

/** The argocd CLI version the recorded fixtures and docs were checked against. */
export const TESTED_WITH = "v3.3.6";
export const VERSION_CHECK_TTL_MS = 12 * 60 * 60 * 1000;

export interface VersionCheck {
  client: string;
  server: string;
  checkedAt: string;
}

interface CacheFile {
  entries: Record<string, VersionCheck>;
}

export function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(base, "argocd-axi", "version-check.json");
}

export function cacheKey(context: string, server: string | undefined): string {
  return `${context}|${server ?? ""}`;
}

function readCache(): CacheFile {
  try {
    const parsed = JSON.parse(
      readFileSync(cachePath(), "utf8"),
    ) as Partial<CacheFile>;
    return {
      entries:
        typeof parsed.entries === "object" && parsed.entries
          ? parsed.entries
          : {},
    };
  } catch {
    return { entries: {} };
  }
}

export function readVersionCheck(key: string): VersionCheck | undefined {
  return readCache().entries[key];
}

function pickVersion(section: unknown): string | undefined {
  if (typeof section !== "object" || section === null) return undefined;
  const record = section as Record<string, unknown>;
  const value = record.Version ?? record.version;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse `argocd version -o json` (`{"client": {...}, "server": {...}}`). */
export function parseVersionOutput(output: unknown): {
  client?: string;
  server?: string;
} {
  if (typeof output !== "object" || output === null) return {};
  const record = output as Record<string, unknown>;
  return {
    client: pickVersion(record.client),
    server: pickVersion(record.server),
  };
}

/** `v3.3.6+abcdef` -> `v3.3.6`. */
export function shortVersion(version: string): string {
  return version.split("+")[0] ?? version;
}

function major(version: string): number | undefined {
  const match = version.match(/^v?(\d+)\./);
  return match ? Number(match[1]) : undefined;
}

export function skewWarning(
  client: string,
  server: string,
): string | undefined {
  const a = major(client);
  const b = major(server);
  if (a === undefined || b === undefined || a === b) return undefined;
  return `argocd CLI ${shortVersion(client)} and server ${shortVersion(server)} differ by a major version; a human installs the CLI matching the server`;
}

export function isStale(check: VersionCheck | undefined, now: number): boolean {
  if (!check) return true;
  const at = Date.parse(check.checkedAt);
  return Number.isNaN(at) || now - at > VERSION_CHECK_TTL_MS;
}

/**
 * Read a recent legacy cache or query the server, without writing any files.
 * Network failures fall back to the legacy value.
 */
export async function refreshVersionCheck(
  context: string,
  server: string | undefined,
  now: number = Date.now(),
): Promise<VersionCheck | undefined> {
  const key = cacheKey(context, server);
  const cached = readVersionCheck(key);
  if (!isStale(cached, now)) return cached;
  try {
    const output = await argocdJson<unknown>("version", ["-o", "json"], {
      context,
    });
    const { client, server: serverVersion } = parseVersionOutput(output);
    if (!client || !serverVersion) return cached;
    const check = {
      client,
      server: serverVersion,
      checkedAt: new Date(now).toISOString(),
    };
    return check;
  } catch {
    return cached;
  }
}
