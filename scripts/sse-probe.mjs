// Raw SSE probe against a runtime origin; prints byte-level framing.
const origin = process.argv[2] ?? "http://127.0.0.1:7413";
const res = await fetch(`${origin}/events`, {
  headers: { Accept: "text/event-stream" },
});
console.log("status", res.status, "ct=", res.headers.get("content-type"));
const dec = new TextDecoder();
let total = 0;
const t0 = Date.now();
for await (const c of res.body) {
  const s = dec.decode(c, { stream: true });
  total += s.length;
  if (total < 2600) console.log("CHUNK", s.length, JSON.stringify(s.slice(0, 420)));
  if (Date.now() - t0 > 9000 || total > 20000) break;
}
console.log("total", total);
process.exit(0);
