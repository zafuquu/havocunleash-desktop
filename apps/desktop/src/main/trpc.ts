/**
 * Minimal tRPC batch client for the bridge.
 * The bridge (server/game-bridge.mjs) speaks tRPC v10 batch envelopes:
 *   GET/POST /api/trpc/<procedure>  with input as {json} envelopes.
 * Procedures used by the desktop: realtime.desktopRooms / desktopRequestAccess /
 * desktopRequestStatus / desktopCancelAccess / desktopProducerTicket /
 * rooms.getLimitsOfRoom.
 */
import { randomUUID } from "node:crypto";

import { logger } from "./logger";

export interface RealtimeRoom {
  roomId: string;
  roomName: string;
  roomGame: string;
  overlayId?: string | null;
}

interface BatchEnvelope {
  index: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class TrpcClient {
  public constructor(private readonly origin: string) {}

  private async call<T>(procedure: string, input: unknown, method: "GET" | "POST" = "GET"): Promise<T> {
    let url = `${this.origin}/api/trpc/${encodeURIComponent(procedure)}?batch=1`;
    let init: RequestInit;
    if (method === "GET") {
      url += `&input=${encodeURIComponent(JSON.stringify({ 0: { json: input ?? {} } }))}`;
      init = { method: "GET" };
    } else {
      init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 0: { json: input ?? {} } }),
      };
    }
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`tRPC ${procedure} HTTP ${res.status}`);
    // The bridge responds with `[{result:{data:{json}}}]` keyed positionally.
    const list = (await res.json()) as TrpcEnvelope[];
    const first = Array.isArray(list) ? list[0] : null;
    if (!first || !first.result) throw new Error(`tRPC ${procedure} failed`);
    return first.result.data.json as T;
  }

  public desktopRooms(): Promise<RealtimeRoom[]> {
    return this.call<RealtimeRoom[]>("realtime.desktopRooms", {}, "GET");
  }

  public desktopRequestAccess(input: {
    roomId: string;
    roomName?: string;
    roomGame?: string;
  }): Promise<{ requestId: string; status: "accepted" }> {
    return this.call("realtime.desktopRequestAccess", input, "POST");
  }

  public desktopRequestStatus(requestId: string): Promise<{
    requestId: string;
    status: string;
    roomGame?: string | null;
    roomId?: string | null;
    roomName?: string;
    overlayId?: string | null;
  }> {
    return this.call("realtime.desktopRequestStatus", { requestId }, "GET");
  }

  public desktopProducerTicket(input: {
    roomId: string;
    roomName?: string;
    roomGame?: string;
  }): Promise<{ ticket: string; realtimeOrigin?: string; expiresAt: string }> {
    return this.call("realtime.desktopProducerTicket", input, "POST");
  }

  /**
   * Cancels a pending access request (the original app exposes this as
   * `api.cancelRoomRequest`). The bridge treats it as best-effort — we use it
   * so a timed-out approval poll never leaves a dangling request behind.
   */
  public desktopCancelAccess(requestId: string): Promise<null> {
    return this.call("realtime.desktopCancelAccess", { requestId }, "POST");
  }

  public getLimitsOfRoom(roomId: string): Promise<{ specialLimits: unknown }> {
    return this.call("rooms.getLimitsOfRoom", { roomId }, "GET");
  }

  /**
   * Room-access approval poll (original flow: request → "pending" → the website
   * dashboard approves → "accepted"; the old renderer polled every 5s).
   * Returns as soon as the request leaves "pending". On timeout the request is
   * cancelled best-effort so the bridge doesn't keep a dangling approval.
   */
  public async awaitRoomAccess(
    requestId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<{
    requestId: string;
    status: string;
    roomId?: string | null;
    roomName?: string;
    roomGame?: string | null;
    overlayId?: string | null;
  }> {
    const intervalMs = opts.intervalMs ?? 5_000;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    let status = await this.desktopRequestStatus(requestId);
    while (status.status === "pending" && Date.now() < deadline) {
      await sleep(intervalMs);
      status = await this.desktopRequestStatus(requestId);
    }
    if (status.status === "pending") {
      await this.desktopCancelAccess(requestId).catch(() => null);
    }
    return status;
  }

  public async listAndPick(): Promise<RealtimeRoom | null> {
    try {
      const rooms = await this.desktopRooms();
      if (rooms.length === 0) {
        logger.info("realtime", "no_rooms_registered");
        return null;
      }
      const first = rooms[0]!;
      logger.info("realtime", "room_selected", { roomId: first.roomId });
      return first;
    } catch (error) {
      logger.error("realtime", "rooms_error", { error: String(error) });
      return null;
    }
  }

  /** Picks the room matching a configured roomId (serverCode); null when absent. */
  public async findRoomById(roomId: string): Promise<RealtimeRoom | null> {
    try {
      const rooms = await this.desktopRooms();
      const found = rooms.find((room) => room.roomId === roomId) ?? null;
      if (found) logger.info("realtime", "room_selected_by_id", { roomId: found.roomId });
      else logger.warn("realtime", "configured_room_not_found", { roomId, known: rooms.map((r) => r.roomId) });
      return found;
    } catch (error) {
      logger.error("realtime", "rooms_error", { error: String(error) });
      return null;
    }
  }
}

interface TrpcEnvelope {
  result?: { data: { json: unknown } };
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}