/** Shared wire contracts (window geometry, anchors, IPC). */
import { z } from "zod";

export * from "./game-data";

export const windowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  windowX: z.number(),
  windowY: z.number(),
  windowWidth: z.number(),
  windowHeight: z.number(),
  clientX: z.number(),
  clientY: z.number(),
  clientWidth: z.number(),
  clientHeight: z.number(),
  titleBarHeight: z.number(),
  isMinimized: z.boolean(),
  isVisible: z.boolean(),
});
export type WindowBounds = z.infer<typeof windowBoundsSchema>;

export const overlayAnchorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("game-window"),
    gameName: z.string().min(1),
    hideWhenTargetMinimized: z.boolean().optional().default(true),
    hideWhenTargetMissing: z.boolean().optional().default(true),
    followIntervalMs: z.number().int().positive().max(5000).optional().default(1000),
  }),
  z.object({
    type: z.literal("display"),
    displayId: z.string().nullable().optional(),
    useWorkArea: z.boolean().optional().default(false),
  }),
]);
export type OverlayAnchorDto = z.infer<typeof overlayAnchorSchema>;

export const MISSING_WINDOW_BOUNDS: WindowBounds = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  windowX: 0,
  windowY: 0,
  windowWidth: 0,
  windowHeight: 0,
  clientX: 0,
  clientY: 0,
  clientWidth: 0,
  clientHeight: 0,
  titleBarHeight: 0,
  isMinimized: true,
  isVisible: false,
};

/** Typed renderer -> main requests. Replies are Zod-parsed on both ends. */
export const ipcRequestSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("overlay:toggleVisibility") }),
  z.object({ channel: z.literal("overlay:setAnchor"), anchor: overlayAnchorSchema }),
  z.object({ channel: z.literal("hud:getUrl") }),
  z.object({ channel: z.literal("relay:getState") }),
]);
export type IpcRequest = z.infer<typeof ipcRequestSchema>;
