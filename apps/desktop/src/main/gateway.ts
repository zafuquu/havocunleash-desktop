/**
 * Local gateway (:7150) — receives CS2 Game State Integration POSTs
 * (mirroring the audited config's uri/token design) plus an /activate ping.
 */
import http from "node:http";

import { logger } from "./logger";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TOKEN = "fork-local-gsi-token";

export class LocalGateway {
  private activePort: number | null = null;

  public constructor(
    private readonly port: number,
    private readonly onGsiPost: (payload: unknown) => void,
    private readonly token: string = process.env.HAVOC_GSI_TOKEN ?? DEFAULT_TOKEN,
  ) {}

  public async start(): Promise<void> {
    // Port-conflict tolerant startup (the audited sibling app owns 7150
    // whenever both stacks run side-by-side).
    let lastError: unknown = null;
    for (let candidate = this.port; candidate < this.port + 10; candidate += 1) {
      const server = http.createServer((req, res) => this.route(req, res));
      const attemptPort = candidate;
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => reject(error);
          server.once("error", onError);
          server.listen(attemptPort, "127.0.0.1", () => {
            server.off("error", onError);
            resolve();
          });
        });
        this.activePort = attemptPort;
        logger.info("local-gateway", "listening", { port: attemptPort });
        return;
      } catch (error) {
        lastError = error;
        server.close();
      }
    }
    throw new Error(
      `local-gateway could not bind ${this.port}..${this.port + 9}: ${String(lastError)}`,
    );
  }

  public get listeningPort(): number {
    return this.activePort ?? this.port;
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (req.method === "GET") {
      if (url.pathname === "/activate") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "havoc-unleash-local-gateway" }));
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/gsi/cs2") {
      const auth = req.headers.authorization ?? "";
      const provided = auth.replace(/^Bearer\s+/i, "").trim() || (req.headers["x-gsi-token"] as string | undefined)?.trim() || "";
      if (provided !== this.token) {
        logger.warn("local-gateway", "gsi_unauthorized");
        res.writeHead(401, { connection: "close" });
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let oversized = false;
      req.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > MAX_BODY_BYTES) oversized = true;
        else chunks.push(c);
      });
      req.on("end", () => {
        if (oversized) {
          res.writeHead(413, { connection: "close" });
          res.end();
          return;
        }
        try {
          this.onGsiPost(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          res.writeHead(400, { connection: "close" });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }
}
