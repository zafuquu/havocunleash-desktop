/**
 * Data-source adapter registry (Phase 3 — hybrid adapter scaffold).
 *
 * Every capture path is an ADAPTER behind one contract, exactly like the
 * original app's per-game `data-source adapter → projection session` shape
 * (see BLOB-AUDIT.md §6). The desktop consumes one wire dialect — the
 * runtime's `/events`+`/facts`+`/health` HTTP/SSE surface on `runtimeOrigin`
 * — regardless of which adapter produces it:
 *
 *   native-runtime    captureExe set ⇒ spawn the PROVEN original capture
 *                     engine (blob-game-data-runtime.exe, upstream dialect,
 *                     fixed port 7413). This is the default production path.
 *   builtin-runtime   captureExe absent ⇒ the fork's own node runtime
 *                     (GEP PackageManager-emulator provider, port 7423).
 *
 * Planned adapters (not yet wired — documented so the shape is stable):
 *   gep-direct-addon  spawn the GEP package in DIRECT-ADDON mode against a
 *                     local Riot-client (needs a Riot dev app — blocked).
 *   riot-api          poll the Riot local + web APIs (dev key — blocked).
 *   mock-replay       feed recorded fact streams (deterministic tests).
 *
 * Selection is a pure function of the loaded config so tests can pin both
 * branches without spawning anything.
 */
import type { AppConfig } from "./config";

export type DataSourceKind = "native-runtime" | "builtin-runtime";

export interface DataSourceSelection {
  readonly kind: DataSourceKind;
  /** Wire origin the projection layer connects to. */
  readonly runtimeOrigin: string;
  /** Engine executable for spawn-capable kinds ("" = built-in). */
  readonly enginePath: string;
}

export function selectDataSource(cfg: Pick<AppConfig, "captureExe" | "runtimeOrigin">): DataSourceSelection {
  if (cfg.captureExe.trim()) {
    return { kind: "native-runtime", runtimeOrigin: cfg.runtimeOrigin, enginePath: cfg.captureExe };
  }
  return { kind: "builtin-runtime", runtimeOrigin: cfg.runtimeOrigin, enginePath: "" };
}