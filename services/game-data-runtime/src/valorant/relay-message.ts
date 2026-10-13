/**
 * Relay-message shim — the subset of @havoc-platform/common-lib/game-data/relay-message
 * the ported Valorant modules consume.
 */

/** Source tag on every relayed observation (OW = Overwolf GEP, OCR = screen reading). */
export type HavocDataSource = "OW" | "OCR" | string;

/** One relayed game-data packet (the runtime's wire unit). */
export interface HavocGameDataPacket {
  havoc_data_source?: HavocDataSource;
  data: unknown;
  event: string;
}
