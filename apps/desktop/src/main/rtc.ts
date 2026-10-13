/**
 * WebRTC producer delivery — parity with the audited upstream RtcPeerDelivery,
 * wired to the fork bridge's signaling contract:
 *
 *   bridge -> producer : game-data:attempt:offer-needed {attemptId, producerSessionId, viewerSessionId}
 *   producer -> bridge : game-data:signal:offer    {..envelope, offer:{type:'offer',sdp}}
 *   bridge -> producer : game-data:signal:answer   {..envelope, answer:{type:'answer',sdp}}
 *   both ways          : game-data:signal:candidate {..envelope, candidate}
 *                      : game-data:signal:end-of-candidates
 *
 * The producer OFFERS (like upstream) and creates the two overlay lanes:
 *   - `havoc-overlay-v3-reliable`  ordered  (bootstrap/snapshots/events)
 *   - `havoc-overlay-v3-telemetry` lossy    (latest-only; bridge ignores it)
 *
 * Wire frames are the SAME JSON payloads the `game-data:fallback` path uses,
 * so the bridge's handleReliableMessage consumes either identically:
 *   {kind:'game-bootstrap', snapshot} | {kind:'game-snapshot', game} | {kind:'game-event', event}
 *
 * Degrades gracefully: when @roamhq/wrtc is unavailable the producer keeps
 * using the socket.io fallback transparently.
 */
import { logger } from "./logger";

/* eslint-disable @typescript-eslint/no-explicit-any */
type K = any;

const MAX_RELIABLE_BUFFERED_AMOUNT = 1_048_576;

function loadWrtc(): K | null {
  try {
    return require("@roamhq/wrtc") as K;
  } catch {
    return null;
  }
}

function defaultIceServers(): string[] {
  const override = (process.env.HAVOC_ICE_SERVERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (override.length > 0) return override;
  return ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];
}

export class RtcPeerDelivery {
  private wrtc: K | null = null;
  private wrtcLoaded = false;
  private socket: K | null = null;
  private producerSessionId: string | null = null;
  private pc: K | null = null;
  private attemptId: string | null = null;
  private reliable: K | null = null;
  private telemetry: K | null = null;
  private disposed = false;
  private onOpenCallbacks = new Set<() => void>();
  private bootstrapProvider: (() => unknown) | null = null;

  public setBootstrapProvider(fn: () => unknown): void {
    this.bootstrapProvider = fn;
  }

  public get available(): boolean {
    if (!this.wrtcLoaded) {
      this.wrtc = loadWrtc();
      this.wrtcLoaded = true;
      if (this.wrtc) logger.info("rtc", "wrtc_loaded");
      else logger.warn("rtc", "wrtc_unavailable_fallback_only");
    }
    return this.wrtc !== null;
  }

  public get isOpen(): boolean {
    return this.reliable?.readyState === "open";
  }

  public onChannelOpen(fn: () => void): void {
    this.onOpenCallbacks.add(fn);
    if (this.isOpen) fn();
  }

  public attach(socket: K, producerSessionId: string): void {
    if (!this.available) return;
    this.socket = socket;
    this.producerSessionId = producerSessionId;
    socket.on("game-data:attempt:offer-needed", (msg: any) => {
      void this.handleOfferNeeded(msg).catch((error) =>
        logger.error("rtc", "offer_failed", {
          attemptId: msg?.attemptId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    socket.on("game-data:signal:answer", (msg: any) => {
      void this.handleAnswer(msg);
    });
    socket.on("game-data:signal:candidate", (msg: any) => {
      void this.handleRemoteCandidate(msg);
    });
    socket.on("game-data:signal:end-of-candidates", () => {
      /* viewer's gathering complete; nothing to do as offerer */
    });
    logger.info("rtc", "signaling_attached", { producerSessionId });
  }

  public detach(): void {
    this.disposed = true;
    this.closePeer();
    this.socket = null;
    this.producerSessionId = null;
  }

  public sendReliable(message: unknown): boolean {
    if (!this.isOpen || !this.reliable) return false;
    if (this.reliable.bufferedAmount > MAX_RELIABLE_BUFFERED_AMOUNT) {
      logger.warn("rtc", "reliable_backpressure_drop");
      return false;
    }
    try {
      this.reliable.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logger.warn("rtc", "send_failed_closing_peer", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.closePeer();
      return false;
    }
  }

  private async handleOfferNeeded(msg: any): Promise<void> {
    if (this.disposed || !this.wrtc || !this.socket) return;
    const { attemptId, producerSessionId, viewerSessionId } = msg ?? {};
    if (!attemptId || !viewerSessionId) return;
    this.closePeer();
    this.attemptId = attemptId;

    const wrtc = this.wrtc;
    const pc = new wrtc.RTCPeerConnection({
      iceServers: defaultIceServers().map((urls) => ({ urls })),
    });
    this.pc = pc;

    this.reliable = pc.createDataChannel("havoc-overlay-v3-reliable", { ordered: true });
    this.telemetry = pc.createDataChannel("havoc-overlay-v3-telemetry", {
      ordered: false,
      maxRetransmits: 0,
    });

    this.reliable.onopen = () => {
      logger.info("rtc", "reliable_channel_open", { attemptId, viewerSessionId });
      try {
        const bootstrap = this.bootstrapProvider?.();
        this.reliable?.send(JSON.stringify({ kind: "game-bootstrap", snapshot: bootstrap ?? null }));
      } catch {
        /* bootstrap is best-effort */
      }
      for (const fn of this.onOpenCallbacks) {
        try {
          fn();
        } catch {
          /* listener failures must not break the lane */
        }
      }
    };
    this.reliable.onclose = () => {
      logger.info("rtc", "reliable_channel_closed", { attemptId });
    };
    this.reliable.onerror = () => this.closePeer();

    pc.onicecandidate = (event: any) => {
      const envelope = { attemptId, producerSessionId, viewerSessionId };
      if (!this.socket) return;
      if (event.candidate) {
        this.socket.emit("game-data:signal:candidate", {
          ...envelope,
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        });
      } else {
        this.socket.emit("game-data:signal:end-of-candidates", envelope);
      }
    };
    pc.onconnectionstatechange = () => {
      logger.info("rtc", "peer_state", { attemptId, state: pc.connectionState });
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.closePeer();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.socket.emit("game-data:signal:offer", {
      attemptId,
      producerSessionId,
      viewerSessionId,
      offer: { type: "offer", sdp: pc.localDescription.sdp },
    });
    logger.info("rtc", "offer_sent", { attemptId, viewerSessionId });
  }

  private async handleAnswer(msg: any): Promise<void> {
    if (!this.pc || !this.wrtc) return;
    if (this.attemptId && msg?.attemptId !== this.attemptId) return;
    try {
      await this.pc.setRemoteDescription(new this.wrtc.RTCSessionDescription(msg.answer));
      logger.info("rtc", "answer_applied", { attemptId: msg?.attemptId });
    } catch (error) {
      logger.error("rtc", "answer_rejected", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.closePeer();
    }
  }

  private async handleRemoteCandidate(msg: any): Promise<void> {
    if (!this.pc || !this.wrtc) return;
    if (this.attemptId && msg?.attemptId !== this.attemptId) return;
    try {
      if (msg?.candidate) {
        await this.pc.addIceCandidate(new this.wrtc.RTCIceCandidate(msg.candidate));
      }
    } catch (error) {
      logger.warn("rtc", "candidate_rejected", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private closePeer(): void {
    if (this.pc) {
      try {
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      } catch {
        /* already closed */
      }
    }
    this.pc = null;
    this.reliable = null;
    this.telemetry = null;
    this.attemptId = null;
  }
}
