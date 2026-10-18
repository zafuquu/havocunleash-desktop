/**
 * Desktop PKCE sign-in — flows through the bridge's auth endpoints
 * (server/game-bridge.mjs `/auth/login` + `/electron/token`).
 *
 *   1. Generate a random `state` + S256 `code_challenge`, open
 *      `${appBase}/auth/login?client_id=electron&code_challenge=<>state=<>`
 *      (the website → Discord → returns a base64url {identifier,state} token
 *      into the deep link).
 *   2. Electron catches `havoc-desktop://auth/callback#token=`.
 *   3. POST `${bridge}/electron/token` {token,state,code_verifier} → the
 *      bridge verifies PKCE, mints a session cookie + returns {token,user}.
 */
import crypto from "node:crypto";
import { shell } from "electron";

import { logger } from "./logger";

export interface HavocSessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

export interface HavocSession {
  sessionToken: string;
  user: HavocSessionUser;
}

/** Minimal key/value persistence (safeStorage-encrypted at rest). */
export interface SessionStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

const SESSION_KEY = "__havocForkSession";

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export interface PendingContext {
  state: string;
  codeChallenge: string;
  codeVerifier: string;
}

export function createPendingContext(): PendingContext {
  const state = crypto.randomBytes(24).toString("base64url");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  return { state, codeChallenge: sha256Base64Url(codeVerifier), codeVerifier };
}

export class DesktopAuth {
  public constructor(
    private readonly appBase: string,
    private readonly bridgeOrigin: string,
    private readonly protocol: string,
    private readonly store: SessionStore,
    private readonly openUrlInBrowser: (url: string) => void = (url) => void shell.openExternal(url),
  ) {}

  public protocolName(): string {
    return this.protocol;
  }

  /** Begin the desktop sign-in: open the website `/auth/login` with PKCE. */
  public async begin(context: PendingContext = createPendingContext()): Promise<PendingContext> {
    const url =
      `${this.appBase}/auth/login` +
      `?client_id=electron&code_challenge=${encodeURIComponent(context.codeChallenge)}` +
      `&state=${encodeURIComponent(context.state)}`;
    logger.info("auth", "login_started", { appBase: this.appBase, state: context.state.slice(0, 8) });
    this.openUrlInBrowser(url);
    return context;
  }

  /** Exchange the one-time identifier the deep link delivered for a real session. */
  public async completeLogin(rawToken: string, pending: PendingContext): Promise<HavocSession> {
    // The website deep-links `#token=<base64url JSON {identifier, state}>`; the
    // bridge looks up `electron-pkce:<identifier>` and verifies state + PKCE.
    let identifier = rawToken;
    let linkedState = pending.state;
    try {
      const decoded = JSON.parse(Buffer.from(rawToken, "base64url").toString("utf8")) as {
        identifier?: unknown;
        state?: unknown;
      };
      if (typeof decoded.identifier === "string") {
        identifier = decoded.identifier;
        if (typeof decoded.state === "string") linkedState = decoded.state;
      }
    } catch {
      // Some flows deliver the raw identifier directly — keep it as-is.
    }
    if (linkedState !== pending.state) {
      throw new Error("login state mismatch (sign-in request expired — try again)");
    }
    const res = await fetch(`${this.bridgeOrigin}/electron/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: identifier,
        state: pending.state,
        code_verifier: pending.codeVerifier,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`token exchange failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const payload = (await res.json()) as { token?: string; user?: HavocSessionUser };
    if (!payload.token) throw new Error("bridge returned no session token");
    const session: HavocSession = {
      sessionToken: payload.token,
      user: payload.user ?? { id: "anonymous", email: "", name: "Session", image: null },
    };
    this.store.set(SESSION_KEY, session);
    logger.info("auth", "session_established", { userId: session.user.id });
    return session;
  }

  public load(): HavocSession | null {
    const v = this.store.get(SESSION_KEY) as HavocSession | undefined;
    return v && typeof v === "object" && "sessionToken" in v ? v : null;
  }

  public clear(): void {
    this.store.delete(SESSION_KEY);
  }
}

/** Point a window at the website's overlay pop-out page. */
export function overlayPopoutUrl(
  appBase: string,
  roomCode: string,
  overlayId: string,
  screen = "default",
  bridgeWs?: string,
): string {
  // local=1: the overlay page must consume the LOCAL authoritative stream
  // (ws://127.0.0.1:7103/ws/broadcast via the existing source-selection
  // failover) instead of the WAN bridge. Live 2026-09-25: without it the
  // popout ran on the remote bridge (bursty, 100-300 ms jitter) which is what
  // made scene/animation updates stutter. Remote operators simply never see a
  // local source and keep failing over to the bridge.
  // bridgeWs: the popout's BRIDGE source defaults to the hardcoded Render
  // deployment (wss://hu-bridge.onrender.com/ws/live) — pass the configured
  // bridge origin (converted to ws scheme) so self-hosted bridges receive the
  // /ws/live feed too (local=1 keeps the local stream authoritative).
  let url = `${appBase}/${roomCode}/${overlayId}?screen=${encodeURIComponent(screen)}&isPopout=true&local=1`;
  if (bridgeWs) {
    const wsUrl = bridgeWs.replace(/^http/, "ws");
    url += `&bridgeWs=${encodeURIComponent(wsUrl)}`;
  }
  return url;
}

/**
 * Extract the one-time token from a deep link. Tolerates the formats the
 * original app accepted: `scheme://#token=<b64>` (hash) and `scheme://?token=`
 * (query). The token payload is a base64url `{identifier, state}` object.
 */
export function extractTokenFromDeepLink(url: string): string | null {
  const hashIdx = url.indexOf("#token=");
  if (hashIdx >= 0) {
    const raw = url.slice(hashIdx + "#token=".length);
    const end = raw.indexOf("&");
    return decodeURIComponent(end >= 0 ? raw.slice(0, end) : raw);
  }
  try {
    const parsed = new URL(url);
    const t = parsed.searchParams.get("token");
    if (t) return decodeURIComponent(t);
  } catch {
    /* custom-scheme URLs without // can fail URL parsing — regex fallback below */
  }
  const match = url.match(/[?&]token=([^&#]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}
