import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { createStreamProxy, SegmentCache, rewritePlaylist } from "../backend/lib/stream-proxy.js";
const require = createRequire(new URL("../backend/package.json", import.meta.url));
const express = require("express");

test("playlist rewrites segment, key, variant and map URLs through same origin", () => {
  const result = rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/keys/one"\n#EXT-X-MAP:URI="init.mp4"\nhttps://up.test/stream/a.ts?token=abc\n../other/index.m3u8', "https://up.test/stream/index.m3u8");
  assert.match(result, /URI="\/cctv\/keys\/one"/);
  assert.match(result, /URI="\/cctv\/stream\/init.mp4"/);
  assert.match(result, /\/cctv\/stream\/a.ts\?token=abc/);
  assert.match(result, /\/cctv\/other\/index.m3u8/);
  assert.throws(() => rewritePlaylist("<html>offline</html>", "https://up.test/index.m3u8"));
  assert.throws(() => rewritePlaylist("#EXTM3U\nhttps://another.test/steal.ts", "https://up.test/index.m3u8"));
});
test("segment cache evicts by byte budget and TTL", () => {
  const cache = new SegmentCache(5);
  cache.set("a", { body: Buffer.alloc(3) }); cache.set("b", { body: Buffer.alloc(3) });
  assert.equal(cache.get("a"), null); assert.equal(cache.bytes, 3);
  cache.set("large", { body: Buffer.alloc(10) }); assert.equal(cache.bytes, 3);
  const expired = new SegmentCache(5, -1); expired.set("a", { body: Buffer.alloc(2) });
  assert.equal(expired.get("a"), null); assert.equal(expired.bytes, 0);
});
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
test("proxy shares segment fetches, never caches playlists/errors, preserves ranges and times out", async (t) => {
  const counts = new Map();
  const upstream = http.createServer((req, res) => {
    counts.set(req.url, (counts.get(req.url) ?? 0) + 1);
    if (req.url === "/slow.ts") return;
    if (req.url === "/error.ts") { res.writeHead(503); return res.end("offline"); }
    if (req.url.endsWith(".m3u8")) return res.end("#EXTM3U\n#EXTINF:2,\n/segment.ts\n");
    if (req.headers.range) { res.writeHead(206, { "Content-Range": "bytes 0-2/7" }); return res.end("seg"); }
    setTimeout(() => res.end("segment"), 30);
  });
  const upPort = await listen(upstream);
  // Allow scheduler contention from concurrent browser/build work. This checks
  // timeout handling, not a 150ms latency guarantee for the local test server.
  const proxy = createStreamProxy(`http://127.0.0.1:${upPort}`, { timeoutMs: 2000 });
  const app = express(); app.use("/cctv", proxy.middleware);
  const server = http.createServer(app); const port = await listen(server);
  t.after(() => { proxy.close(); server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); });
  const get = (path, opts) => fetch(`http://127.0.0.1:${port}/cctv${path}`, opts);
  const [one, two] = await Promise.all([get("/segment.ts"), get("/segment.ts")]);
  assert.equal(await one.text(), "segment"); assert.equal(await two.text(), "segment");
  assert.equal(counts.get("/segment.ts"), 1);
  const cached = await get("/segment.ts"); assert.equal(cached.headers.get("x-stream-cache"), "HIT");
  const list = await get("/index.m3u8"); assert.match(await list.text(), /\/cctv\/segment.ts/);
  await get("/index.m3u8"); assert.equal(counts.get("/index.m3u8"), 2);
  await get("/error.ts"); await get("/error.ts"); assert.equal(counts.get("/error.ts"), 2);
  const partial = await get("/segment.ts", { headers: { Range: "bytes=0-2" } });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), "bytes 0-2/7");
  assert.equal((await get("/slow.ts")).status, 502);
  assert.equal((await get("/segment.ts", { method: "POST" })).status, 405);
  assert.equal(proxy.snapshot().errors, 1);
});
