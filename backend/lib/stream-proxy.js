import http from "node:http";
import https from "node:https";

export function rewritePlaylist(text, playlistUrl, prefix = "/cctv") {
  if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("Upstream tidak mengirim playlist HLS.");
  const base = new URL(playlistUrl);
  const rewrite = (value) => {
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.username || url.password) {
      throw new Error("Playlist menunjuk host di luar upstream CCTV.");
    }
    return `${prefix}${url.pathname}${url.search}`;
  };
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (!line.startsWith("#")) return rewrite(line.trim());
    return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewrite(uri)}"`);
  }).join("\n");
}

/** A bounded cache: never cache mutable playlists or error responses. */
export class SegmentCache {
  constructor(maxBytes = 64 * 1024 * 1024, ttlMs = 60000) {
    this.maxBytes = maxBytes; this.ttlMs = ttlMs;
    this.entries = new Map(); this.bytes = 0;
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= Date.now()) { this.remove(key); return null; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    const size = value.body.length;
    if (size > this.maxBytes) return;
    this.remove(key);
    for (const [oldKey, entry] of this.entries) {
      if (entry.expires <= Date.now()) this.remove(oldKey);
    }
    while (this.bytes + size > this.maxBytes && this.entries.size) this.remove(this.entries.keys().next().value);
    this.entries.set(key, { value, size, expires: Date.now() + this.ttlMs });
    this.bytes += size;
  }
  remove(key) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.size; this.entries.delete(key); }
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}

export function createStreamProxy(upstream, { timeoutMs = 20000, maxBytes = 16 * 1024 * 1024,
  cacheBytes = 64 * 1024 * 1024 } = {}) {
  const origin = new URL(upstream);
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("CCTV_UPSTREAM tidak valid.");
  const transport = origin.protocol === "https:" ? https : http;
  const agent = new transport.Agent({ keepAlive: true, keepAliveMsecs: 10000,
    maxSockets: 12, maxFreeSockets: 6, scheduling: "lifo" });
  const cache = new SegmentCache(cacheBytes);
  const pending = new Map();
  const stats = { upstreamRequests: 0, cacheHits: 0, sharedRequests: 0, errors: 0,
    lastFetchMs: null, lastError: "" };

  const download = (url, range) => new Promise((resolve, reject) => {
    const started = performance.now();
    stats.upstreamRequests++;
    const request = transport.get(url, { agent, headers: {
      Accept: "*/*", "Accept-Encoding": "identity", ...(range ? { Range: range } : {}),
    } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) request.destroy(new Error("Respons CCTV terlalu besar."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        stats.lastFetchMs = Math.round(performance.now() - started);
        resolve({ status: response.statusCode ?? 502, headers: response.headers,
          body: Buffer.concat(chunks) });
      });
    });
    // Total deadline includes connection, headers and body, unlike socket timeout.
    const deadline = setTimeout(() => request.destroy(new Error("Timeout upstream CCTV.")), timeoutMs);
    request.on("error", reject);
    request.on("close", () => clearTimeout(deadline));
  });

  const middleware = async (req, res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (!["GET", "HEAD"].includes(req.method)) return res.status(405).json({ ok: false, error: "Gunakan GET atau HEAD." });
    try {
      const url = new URL(req.url, origin);
      if (url.origin !== origin.origin || url.username || url.password) return res.status(400).json({ ok: false, error: "Path CCTV tidak valid." });
      const playlist = /\.m3u8$/i.test(url.pathname);
      const range = req.headers.range;
      const cacheable = !range && /\.(ts|m4s)$/i.test(url.pathname);
      const key = url.href;
      let result = cacheable ? cache.get(key) : null;
      let cacheStatus = "MISS";
      if (result) { stats.cacheHits++; cacheStatus = "HIT"; }
      else if (cacheable && pending.has(key)) {
        stats.sharedRequests++; cacheStatus = "SHARED";
        result = await pending.get(key);
      } else {
        if (pending.size >= 24) return res.status(503).json({ ok: false, error: "Proxy sedang sibuk." });
        const promise = download(url, range);
        if (cacheable) pending.set(key, promise);
        try {
          result = await promise;
          if (cacheable && result.status === 200 && !/no-store|private/i.test(String(result.headers["cache-control"] ?? ""))) cache.set(key, result);
        } finally { if (cacheable) pending.delete(key); }
      }
      if (res.destroyed) return;
      // Redirects are explicit errors; never send the browser to a CORS URL.
      if (result.status >= 300 && result.status < 400) throw new Error("Upstream CCTV mengalihkan request.");
      let body = result.body;
      if (playlist && result.status === 200) body = Buffer.from(rewritePlaylist(body.toString("utf8"), url));
      res.status(result.status);
      res.setHeader("Cache-Control", playlist || !cacheable ? "no-store" : "private, max-age=30");
      res.setHeader("X-Stream-Cache", cacheStatus);
      res.setHeader("Content-Type", playlist ? "application/vnd.apple.mpegurl" : result.headers["content-type"] ?? "application/octet-stream");
      for (const header of ["content-range", "accept-ranges"]) {
        if (result.headers[header]) res.setHeader(header, result.headers[header]);
      }
      res.setHeader("Content-Length", body.length);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      stats.errors++; stats.lastError = error.message;
      if (!res.headersSent && !res.destroyed) res.status(502).json({ ok: false, error: "Gagal mengambil stream CCTV.", detail: error.message });
    }
  };
  return { middleware, snapshot: () => ({ ...stats, cacheBytes: cache.bytes,
    cacheEntries: cache.entries.size, inflightSegments: pending.size }),
    close: () => { agent.destroy(); cache.clear(); } };
}
