/**
 * Game-data runtime consumer.
 * Contract: first SSE data frame MUST be valorant_session_snapshot; later
 * snapshots gated by strictly increasing revision; facts as new_* envelopes;
 * exponential backoff reconnects (1s->30s, 6 tries/generation).
 */
import {
  GAME_DATA_RUNTIME_PATHS,
  gameDataRuntimeHealthSchema,
  type StreamFrame,
  type ValorantSessionSnapshot,
  streamFrameSchema,
} from "@havoc-unleash/contracts";
import { logger } from "./logger";

export interface RuntimeClientCallbacks {
  onBootstrapRequired?: () => void;
  onFact: (fact: { kind: "new_info_update" | "new_game_event"; key: string; value: unknown }) => void;
  onGameState: (frame: Extract<StreamFrame, { kind: "game_detected" | "game_exit" }>) => void;
  onScore: (score: { matchId: string; blue: number; red: number }) => void;
  onSnapshot: (snapshot: ValorantSessionSnapshot) => void;
  onStatus: (status: { connected: boolean; reason?: string }) => void;
}

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 6;
const STABLE_RESET_MS = 30_000;

export class GameDataRuntimeClient {
  private abort: AbortController | null = null;
  private generation = 0;

  public constructor(private readonly origin: string, private readonly cb: RuntimeClientCallbacks) {}

  public async start(): Promise<void> {
    this.generation += 1;
    const gen = this.generation;
    this.abort = new AbortController();
    let attempts = 0;

    while (!this.abort.signal.aborted && gen === this.generation) {
      let connectedAt = 0;
      try {
        await this.assertHealthy();
        const startedAt = Date.now();
        await this.streamOnce((ok) => {
          if (ok) connectedAt = Date.now() - startedAt;
        });
        if (Date.now() - startedAt >= STABLE_RESET_MS) attempts = 0;
      } catch (error) {
        if (this.abort?.signal.aborted || gen !== this.generation) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("runtime-client", "stream_reconnecting", { attempt: attempts + 1, message });
        void connectedAt;
      }
      if (++attempts > MAX_ATTEMPTS) {
        logger.error("runtime-client", "retries_exhausted");
        this.notify("onStatus", () => this.cb.onStatus({ connected: false, reason: "runtime_unavailable" }));
        await sleep(60_000, this.abort.signal);
        attempts = 0;
        continue;
      }
      const delay = Math.min(INITIAL_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);
      this.notify("onStatus", () => this.cb.onStatus({ connected: false }));
      await sleep(delay, this.abort.signal);
    }
  }

  public stop(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
  }

  /**
   * Consumer callbacks (projection / publisher) run synchronously inside the
   * stream read loop, so a throw there used to tear the whole subscription down
   * and burn the reconnect budget — the 2026-09-24 incident: one bad frame in
   * the projection stopped ALL telemetry. A consumer must be able to fail
   * without killing the stream.
   */
  private notify(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      logger.error("runtime-client", "callback_failed", {
        label,
        error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      });
    }
  }

  private async assertHealthy(): Promise<void> {
    const res = await fetch(`${this.origin}${GAME_DATA_RUNTIME_PATHS.health}`, {
      signal: AbortSignal.timeout(750),
    });
    if (!res.ok) throw new Error(`health HTTP ${res.status}`);
    const parsed = gameDataRuntimeHealthSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("malformed_health");
    if (parsed.data.runtime.state !== "ready") throw new Error(`state=${parsed.data.runtime.state}`);
  }

  private async streamOnce(markConnected: (ok: boolean) => void): Promise<void> {
    let bootstrapped = false;
    let acceptedRevision = -1;

    const res = await fetch(`${this.origin}${GAME_DATA_RUNTIME_PATHS.events}`, {
      headers: { Accept: "text/event-stream" },
      signal: this.abort!.signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);

    markConnected(true);
    logger.info("runtime-client", "stream_connected");
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      if (this.abort?.signal.aborted) return;
      buffer += decoder.decode(chunk, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const jsonLines = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (jsonLines.length === 0) continue; // comment/ping

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(jsonLines.join("\n"));
        } catch {
          continue;
        }
        parsedJson = normalizeEngineFrame(parsedJson);
        const frame = streamFrameSchema.safeParse(parsedJson);
        if (!frame.success) {
          // Boundary telemetry: payload/schema validation result.
          if (process.env.HAVOC_DEBUG_PIPELINE === "1") {
            logger.debug("pipeline", "runtime_frame_schema_rejected", {
              kind: (parsedJson as { kind?: unknown })?.kind ?? null,
            });
          }
          continue; // tolerate future kinds
        }

        const msg = frame.data;
        if (!bootstrapped) {
          if (msg.kind !== "valorant_session_snapshot") continue;
          bootstrapped = true;
          acceptedRevision = msg.snapshot.revision;
          // Boundary telemetry: subscription established + first payload.
          if (process.env.HAVOC_DEBUG_PIPELINE === "1") {
            logger.debug("pipeline", "runtime_bootstrap_received", {
              revision: msg.snapshot.revision,
              sessionPhase: msg.snapshot.sessionPhase ?? null,
              matchId: msg.snapshot.matchId ?? null,
              teams: msg.snapshot.teams?.length ?? null,
            });
          }
          this.notify("onSnapshot", () => this.cb.onSnapshot(msg.snapshot));
          continue;
        }

        switch (msg.kind) {
          case "valorant_session_snapshot": {
            if (msg.snapshot.revision <= acceptedRevision) break;
            acceptedRevision = msg.snapshot.revision;
            this.notify("onSnapshot", () => this.cb.onSnapshot(msg.snapshot));
            break;
          }
          case "valorant_score_snapshot":
            this.notify("onScore", () => this.cb.onScore(msg.score));
            break;
          case "new_info_update":
            this.notify("onFact", () =>
              this.cb.onFact({ kind: "new_info_update", key: msg.data.key, value: msg.data.value }),
            );
            break;
          case "new_game_event":
            this.notify("onFact", () =>
              this.cb.onFact({ kind: "new_game_event", key: msg.data.key, value: msg.data.value }),
            );
            break;
          case "game_detected":
          case "game_exit":
            this.notify("onGameState", () => this.cb.onGameState(msg));
            break;
          default:
            break;
        }
      }
    }
    if (!bootstrapped) throw new Error("invalid_bootstrap");
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * The original capture engine speaks a slightly different wire dialect than
 * the fork's contracts. Normalize BEFORE schema validation, otherwise every
 * fact/score frame is silently dropped:
 *
 *   facts:  {kind:'new_info_update', payload:{data:{key,value,gameId}}}   (engine)
 *           {kind:'new_info_update', data:{key,value,gameId}}             (fork)
 *   scores: {kind:'valorant_score_snapshot', score:{ally,enemy,matchId}}  (engine)
 *           {kind:'valorant_score_snapshot', score:{blue,red,matchId}}    (fork)
 */
function normalizeEngineFrame(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const msg = raw as Record<string, unknown>;

  if (msg.kind === "new_info_update" || msg.kind === "new_game_event") {
    if (msg.data === undefined) {
      const payload = msg.payload as
        | { data?: { key?: unknown; value?: unknown; gameId?: unknown }; gameId?: unknown }
        | undefined;
      const item = payload?.data;
      if (item && typeof item.key === "string" && item.key.length > 0) {
        return {
          ...msg,
          data: { key: item.key, value: item.value, gameId: item.gameId ?? payload?.gameId },
        };
      }
    }
    return msg;
  }

  if (msg.kind === "valorant_score_snapshot" && typeof msg.score === "object" && msg.score !== null) {
    const s = msg.score as Record<string, unknown>;
    if (s.blue === undefined && s.ally !== undefined) {
      return {
        ...msg,
        score: {
          matchId: typeof s.matchId === "string" ? s.matchId : "",
          blue: s.ally,
          red: typeof s.enemy === "number" ? s.enemy : 0,
          observedAt: s.observedAt,
        },
      };
    }
  }

  return msg;
}
