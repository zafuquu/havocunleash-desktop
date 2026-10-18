import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HAVOC_RUNTIME_PORT: z.coerce.number().int().min(1).max(65535).default(7423),
  // Hybrid capture mode: point this at the proven original capture engine
  // (e.g. the installed BLOB desktop's blob-game-data-runtime.exe). When set,
  // the desktop spawns THAT engine (port 7413, upstream wire dialect) instead
  // of the built-in node runtime.
  HAVOC_CAPTURE_EXE: z.string().default(""),
  HAVOC_BRIDGE_ORIGIN: z.string().default(""),
  HAVOC_APP_BASE: z.string().default(""),
  // The exact deep-link protocol the website fires on login.
  HAVOC_DESKTOP_PROTOCOL: z.string().default("havoc-desktop"),
  HAVOC_ROOM_ID: z.string().default(""),
  HAVOC_GAME_WINDOW_TITLE: z.string().min(1).default("VALORANT"),
  HAVOC_GATEWAY_PORT: z.coerce.number().default(7155),
  HAVOC_HUD_PORT: z.coerce.number().optional(),
  /** BlobDesktop-REA name for the same port (resolved after HAVOC_HUD_PORT). */
  HAVOC_APP_PORT: z.coerce.number().optional(),
  HAVOC_ANCHOR_OVERLAY: z.string().default("0"),
  /**
   * REA window mode: "hidden"/"overlay" boot as a background companion (no
   * shell window; clicking the app again reveals it), "visible" shows the
   * shell at boot (default — current behaviour).
   */
  HAVOC_APP_WINDOW: z.enum(["hidden", "visible", "overlay"]).default("visible"),
  HAVOC_CONFIG: z.string().default(""),
  HAVOC_DEV_SESSION: z.string().default(""),
  /** Run the Overwolf GEP provider elevated (UAC), like the original app. */
  HAVOC_ELEVATE_GEP: z.string().default("1"),
  // ---- Havoc/old-fork environment names (take precedence, like the original app) ----
  HAVOC_DESKTOP_API_ORIGIN: z.string().default(""),
  HAVOC_DESKTOP_REALTIME_ORIGIN: z.string().default(""),
  HAVOC_DESKTOP_LOGIN_ORIGIN: z.string().default(""),
  HAVOC_DESKTOP_OVERLAY_ORIGIN: z.string().default(""),
  HAVOC_DESKTOP_SKIP_LOGIN: z.string().default(""),
});

/** Defaults mirror the old fork's launch-vercel.bat targeting the deployed stack. */
const HAVOC_DEFAULTS = {
  bridge: "https://hu-bridge.onrender.com",
  app: "https://havocunleashs.vercel.app",
} as const;

export interface AppConfig {
  readonly runtimeOrigin: string;
  /** Hybrid capture mode: path to the original capture engine exe ("" = built-in runtime). */
  readonly captureExe: string;
  readonly bridgeOrigin: string;
  readonly appBase: string;
  readonly overlayOrigin: string;
  readonly desktopProtocol: string;
  /** Every scheme this app accepts deep links on (the website fires havoc-desktop:// first). */
  readonly desktopProtocols: readonly string[];
  readonly roomId: string;
  readonly gameWindowTitle: string;
  readonly gatewayPort: number;
  readonly hudPort: number;
  readonly hudOrigin: string;
  readonly anchorOverlay: boolean;
  readonly appWindow: "hidden" | "visible" | "overlay";
  readonly skipLogin: boolean;
  /** Launch the GEP provider elevated (original-style UAC). Default: on. */
  readonly elevateGep: boolean;
}

type Overrides = {
  appBase?: string;
  bridgeOrigin?: string;
  roomId?: string;
  captureExe?: string;
  appWindow?: "hidden" | "visible" | "overlay";
};

function firstTruthy(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const p = envSchema.parse(env);
  const over = readConfigFile(p.HAVOC_CONFIG);
  const bridgeOrigin = firstTruthy(
    p.HAVOC_DESKTOP_API_ORIGIN,
    p.HAVOC_DESKTOP_REALTIME_ORIGIN,
    p.HAVOC_BRIDGE_ORIGIN,
    over.bridgeOrigin,
    HAVOC_DEFAULTS.bridge,
  )!.replace(/\/+$/, "");
  const appBase = firstTruthy(
    p.HAVOC_DESKTOP_LOGIN_ORIGIN,
    p.HAVOC_APP_BASE,
    over.appBase,
    HAVOC_DEFAULTS.app,
  )!.replace(/\/+$/, "");
  const overlayOrigin = firstTruthy(p.HAVOC_DESKTOP_OVERLAY_ORIGIN, appBase)!.replace(/\/+$/, "");
  const roomId = p.HAVOC_ROOM_ID?.trim() || over.roomId?.trim() || "";
  // Hybrid capture mode: the original capture engine serves the upstream wire
  // dialect on its fixed port 7413.
  const captureExe = p.HAVOC_CAPTURE_EXE?.trim() || over.captureExe || "";
  const runtimeOrigin = captureExe
    ? "http://127.0.0.1:7413"
    : `http://127.0.0.1:${p.HAVOC_RUNTIME_PORT}`;
  const hudPort = p.HAVOC_HUD_PORT ?? p.HAVOC_APP_PORT ?? 7103;
  // Explicit env beats the config file; both beat the schema default.
  const appWindow = env.HAVOC_APP_WINDOW?.trim()
    ? p.HAVOC_APP_WINDOW
    : (over.appWindow ?? p.HAVOC_APP_WINDOW);
  return {
    runtimeOrigin,
    captureExe,
    bridgeOrigin,
    appBase,
    overlayOrigin,
    desktopProtocol: p.HAVOC_DESKTOP_PROTOCOL,
    desktopProtocols: [
      ...new Set([p.HAVOC_DESKTOP_PROTOCOL, "havoc-desktop"].filter(Boolean)),
    ],
    roomId,
    gameWindowTitle: p.HAVOC_GAME_WINDOW_TITLE,
    gatewayPort: p.HAVOC_GATEWAY_PORT,
    hudPort,
    hudOrigin: `http://127.0.0.1:${hudPort}`,
    anchorOverlay: p.HAVOC_ANCHOR_OVERLAY === "1",
    appWindow,
    skipLogin: p.HAVOC_DESKTOP_SKIP_LOGIN === "1" || p.HAVOC_DEV_SESSION === "1",
    elevateGep: p.HAVOC_ELEVATE_GEP !== "0",
  };
}

function readConfigFile(explicitPath: string): Overrides {
  if (explicitPath) {
    const o = tryRead(explicitPath);
    if (o) return o;
    return {};
  }
  const localData = process.env.LOCALAPPDATA ?? process.cwd();
  const candidates = [
    path.join(process.cwd(), "havoc-unleash.config.json"),
    path.join(localData, "havoc-unleash", "config.json"),
    path.join(localData, "HavocUnleash", "config.json"),
  ];
  for (const file of candidates) {
    const o = tryRead(file);
    if (o) return o;
  }
  return {};
}

function tryRead(file: string): Overrides | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      appBase: str(raw["HAVOC_APP_BASE"] ?? raw.appBase),
      bridgeOrigin: str(raw["HAVOC_BRIDGE_ORIGIN"] ?? raw.bridgeOrigin),
      roomId: str(raw["HAVOC_ROOM_ID"] ?? raw.roomId),
      captureExe: str(raw["HAVOC_CAPTURE_EXE"] ?? raw.captureExe),
      appWindow: windowMode(raw["HAVOC_APP_WINDOW"] ?? raw.appWindow),
    };
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function windowMode(v: unknown): "hidden" | "visible" | "overlay" | undefined {
  return v === "hidden" || v === "visible" || v === "overlay" ? v : undefined;
}