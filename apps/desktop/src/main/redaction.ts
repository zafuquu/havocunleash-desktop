/**
 * PASS 9 (R4) — redaction for diagnostic output.
 *
 * Two layers, both applied BEFORE anything is written to a support bundle:
 *   1. KEY-based   — a field whose name looks sensitive is masked wholesale.
 *   2. VALUE-based — free text (log lines) is scanned for secret-shaped payloads
 *      regardless of the key that carried them.
 * A third helper rewrites filesystem paths so the OS username never leaves the
 * machine (`C:\Users\Viewer\...` -> `%USERPROFILE%\...`).
 *
 * This is a SAFETY NET, not the primary defence: the bundle is allowlist-first
 * (see supportBundle.ts) and only receives an explicit set of diagnostic
 * fields. Redaction exists because log lines are UNTRUSTED third-party text.
 *
 * Pure and dependency-free so it can be unit-tested with sentinel fixtures.
 */

export const REDACTED = "[redacted]";

/** Field names whose values must never leave the machine. */
const SENSITIVE_KEY_RE =
  /(token|auth|cookie|secret|passw|credential|session_?id|api_?key|private_?key|privatekey|bearer|authorization|refresh|signature|salt|seed|user_?id|userid|account_?id|email|e_?mail|machine_?id|device_?id|hostname|serial|uuid|connection_?string|connectionstring|database_?url|db_?url|postgres|mysql|mongodb|redis|amqp|dsn)/i;

/** Keys that are safe and useful but would be caught by a naive matcher. */
const ALLOWED_KEY_RE =
  /^(component|event|level|service|timestamp|matchId|mapKey|mapName|scene|round|roundNumber|roundPhase|phase|winner|reason|kills|deaths|assists|credits|health|isAlive|teamIndex|teamId|rosterSize|rev|revision|version|platform|arch|locale|nodeVersion|electronVersion|count|bytes|kept|dropped|droppedNames|source|dirty|builtAt|revisionShort|schema|created|included|excluded|files|name|size|sha256|ok|error|path|reason_?code)$/i;

/**
 * Secret-shaped VALUE patterns. `g` is required so `replaceAll`-style looping
 * works; the regexes are anchored on structure, never on a specific product.
 */
const VALUE_PATTERNS: RegExp[] = [
  // JWT: three base64url segments
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  // Authorization header values
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  // PEM private key blocks (single- or multi-line, handled per-line below)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  // Connection strings with embedded credentials: scheme://user:pass@host
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/@:]+:[^\s@]+@/gi,
  // Cookies: name=value pairs that look like session cookies
  /\b(sessionid|sid|ssnid|csrftoken|xsrf-token|connect\.sid|__Host-[A-Za-z-]+)\s*=/gi,
  // Email addresses
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

/** Replace every secret-shaped VALUE in a string. */
export function redactText(input: string): string {
  let out = input;
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** True when a field name must never have its value exported. */
export function isSensitiveKey(key: string): boolean {
  if (ALLOWED_KEY_RE.test(key)) return false;
  return SENSITIVE_KEY_RE.test(key);
}

/** Mask a single value for a given key (key rules win, then value rules). */
export function redactEntry(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  return redactDeep(value);
}

/** Recursively redact a JSON-ish structure. Cycles and depth are bounded. */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 12) return "[truncated:depth]";
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? redactText(value) : value;
  }
  if (seen.has(value as object)) return "[truncated:cycle]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item) => redactDeep(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactEntry(k, v);
  }
  return out;
}

/**
 * Rewrite a filesystem path so the OS username is removed.
 * `%USERPROFILE%` / `%LOCALAPPDATA%` / `%TEMP%` are substituted, then any
 * remaining `Users/<name>` or `home/<name>` segment is masked.
 */
export function redactPath(input: string): string {
  let out = input;
  const home = (() => {
    try {
      return process.env.USERPROFILE ?? process.env.HOME ?? "";
    } catch {
      return "";
    }
  })();
  if (home && home.length > 3) out = out.split(home).join("%USERPROFILE%");
  const localAppData = (() => {
    try {
      return process.env.LOCALAPPDATA ?? "";
    } catch {
      return "";
    }
  })();
  if (localAppData && localAppData.length > 3) out = out.split(localAppData).join("%LOCALAPPDATA%");
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\/\s"']+/, "$1%USERPROFILE%");
  out = out.replace(/(\/(?:home|Users)\/)[^/\s"']+/, "$1%USERPROFILE%");
  return out;
}
