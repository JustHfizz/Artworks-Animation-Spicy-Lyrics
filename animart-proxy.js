// ============================================================
//  animart-proxy.js  —  Animated Artwork Proxy Server v3
//  Optimasi: pre-transcode warm-up + direct pipe segment→ffmpeg
//            + MSE-ready chunked streaming
//
//  Usage: node animart-proxy.js [720|1080|best]
//
//  Endpoints:
//    GET /artwork?artist=&album=&title=  → { m3u8: "..." | null }
//    GET /transcode?url=<m3u8>           → video/webm (streamed)
//    GET /ping                           → status JSON
//    GET /cache/clear                    → clear all caches
//
//  Requires: Node.js + ffmpeg in PATH
// ============================================================

const http      = require("http");
const https     = require("https");
const { spawn } = require("child_process");
const readline  = require("readline");
const { PassThrough } = require("stream");

const PORT = 7799;

const RESOLUTION_OPTIONS = {
  "720" : { label: "720p  — HD (default)",               height: 720,  bitrate: "0" },
  "1080": { label: "1080p — Full HD, max quality",        height: 1080, bitrate: "0" },
  "best": { label: "Best  — highest quality (auto res)",  height: null, bitrate: "0" },
};

let selectedResolution = null;

async function pickResolution() {
  const arg = process.argv[2]?.toLowerCase()?.trim();

  if (arg && RESOLUTION_OPTIONS[arg]) {
    selectedResolution = RESOLUTION_OPTIONS[arg];
    console.log(`\n🎬 Resolution: ${selectedResolution.label}`);
    return;
  }

  if (arg) console.warn(`\n⚠  Unknown resolution "${arg}". Showing menu.\n`);

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   animart-proxy v3 — Select Resolution           ║");
  console.log("╠══════════════════════════════════════════════════╣");
  const keys = Object.keys(RESOLUTION_OPTIONS);
  keys.forEach((k, i) => {
    console.log(`║  [${i + 1}] ${RESOLUTION_OPTIONS[k].label.padEnd(43)}║`);
  });
  console.log("╚══════════════════════════════════════════════════╝");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise(resolve => {
    const ask = () => {
      rl.question("\nSelect [1-3] (Enter = 720p default): ", answer => {
        const trimmed = answer.trim();
        if (trimmed === "") {
          selectedResolution = RESOLUTION_OPTIONS["720"];
          console.log(`✓ Using default: ${selectedResolution.label}`);
          rl.close(); resolve(); return;
        }
        const idx = parseInt(trimmed) - 1;
        if (idx >= 0 && idx < keys.length) {
          selectedResolution = RESOLUTION_OPTIONS[keys[idx]];
          console.log(`✓ Selected: ${selectedResolution.label}`);
          rl.close(); resolve();
        } else {
          console.log("  Invalid choice, try again.");
          ask();
        }
      });
    };
    ask();
  });
}

// ── API sources ────────────────────────────────────────────
const API_M8TEC     = "https://artwork.m8tec.top/api/v1/artwork/search";
const ITUNES_SEARCH = "https://itunes.apple.com/search";

// ── m3u8 URL cache ─────────────────────────────────────────
const cache          = new Map();
const CACHE_TTL_MS   = 24 * 60 * 60 * 1000;
const CACHE_NONE_MS  =  4 * 60 * 60 * 1000;

// ── WebM cache ─────────────────────────────────────────────
const webmCache         = new Map();
const WEBM_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const WEBM_CACHE_MAX    = 10;

function webmCacheSet(key, webmBuf) {
  if (webmCache.size >= WEBM_CACHE_MAX) {
    webmCache.delete(webmCache.keys().next().value);
    console.log(`[proxy] webm cache full — evicted oldest entry`);
  }
  webmCache.set(key, { webm: webmBuf, ts: Date.now(), hitCount: 0 });
  console.log(`[proxy] webm cache: saved (${(webmBuf.length / 1024).toFixed(0)} KB), entries: ${webmCache.size}`);
}

const inFlight = new Map();

// ── HTTP fetch helpers ─────────────────────────────────────
function isLargeSegment(url) {
  return url.includes("mvod.itunes.apple.com") || url.includes("mzstatic.com");
}

function isHighResSegment(url) {
  return /[_\-/](?:1080|1440|2160|fhd|uhd|hd1080)/i.test(url);
}

function fetchBufOnce(targetUrl, extraHeaders = {}, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const proto     = targetUrl.startsWith("https") ? https : http;
    const timeoutMs = isHighResSegment(targetUrl) ? 45000 : isLargeSegment(targetUrl) ? 30000 : 8000;
    const req = proto.get(targetUrl, {
      headers: {
        "User-Agent"     : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept"         : "*/*",
        "Connection"     : "keep-alive",
        "Accept-Encoding": "identity",
        ...extraHeaders,
      }
    }, res => {
      if (signal?.aborted) { req.destroy(); return reject(new Error("aborted")); }
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(fetchBufOnce(res.headers.location, extraHeaders, signal));
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} → ${targetUrl.slice(0, 80)}`));
      const chunks = [];
      res.on("data", c => { if (signal?.aborted) { req.destroy(); return; } chunks.push(c); });
      res.on("end",  () => signal?.aborted ? reject(new Error("aborted")) : resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout (${timeoutMs / 1000}s): ${targetUrl.slice(0, 60)}`));
    });
    signal?.addEventListener("abort", () => { req.destroy(); reject(new Error("aborted")); }, { once: true });
  });
}

async function fetchBuf(targetUrl, extraHeaders = {}, maxRetry = 5, signal) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await fetchBufOnce(targetUrl, extraHeaders, signal);
    } catch (e) {
      if (signal?.aborted) throw new Error("aborted");
      lastErr = e;
      const retryable = e.code === "ECONNRESET" || e.code === "ECONNREFUSED" ||
                        e.code === "ETIMEDOUT"   || e.message.includes("Timeout");
      if (!retryable || attempt === maxRetry) break;
      console.warn(`[proxy] retry ${attempt}/${maxRetry - 1} (${e.code || e.message.slice(0, 30)}): ${targetUrl.slice(0, 60)}`);
      await new Promise(r => setTimeout(r, 100 + attempt * 50));
    }
  }
  throw lastErr;
}

// ── NEW: fetchStream — ambil segment sebagai Node.js stream (tidak buffer dulu)
// Dipakai untuk pipe langsung ke ffmpeg stdin
function fetchStream(targetUrl, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const proto     = targetUrl.startsWith("https") ? https : http;
    const timeoutMs = isHighResSegment(targetUrl) ? 45000 : isLargeSegment(targetUrl) ? 30000 : 10000;
    const req = proto.get(targetUrl, {
      headers: {
        "User-Agent"     : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept"         : "*/*",
        "Connection"     : "keep-alive",
        "Accept-Encoding": "identity",
      }
    }, res => {
      if (signal?.aborted) { req.destroy(); return reject(new Error("aborted")); }
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(fetchStream(res.headers.location, signal));
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode} → ${targetUrl.slice(0, 80)}`));
      }
      // Resolve dengan response stream langsung
      signal?.addEventListener("abort", () => { req.destroy(); }, { once: true });
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout (${timeoutMs / 1000}s): ${targetUrl.slice(0, 60)}`));
    });
  });
}

const fetchText = async (u, h, signal) => (await fetchBuf(u, h, 5, signal)).toString("utf8");
const fetchJson = async (u, h, signal) => JSON.parse(await fetchText(u, h, signal));

function sanitize(str) {
  if (!str) return "";
  return str
    .replace(/\$/g, "S")
    .replace(/[&+#%@=]/g, " ")
    .replace(/[^\w\s\-'.,()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Source 1: artwork.m8tec.top ───────────────────────────
async function fromM8tec(artist, album, title, signal) {
  const attempts = [
    { artist, album, title },
    { artist: sanitize(artist), album: sanitize(album), title: sanitize(title) },
    { artist: sanitize(artist), album: "",              title: sanitize(title) },
  ];
  const seen = new Set();
  for (const q of attempts.filter(q => {
    const k = `${q.artist}|${q.album}|${q.title}`;
    return seen.has(k) ? false : (seen.add(k), true);
  })) {
    if (signal?.aborted) return null;
    const params = new URLSearchParams({ artist: q.artist || "", album: q.album || "", title: q.title || "" });
    try {
      const json = await fetchJson(`${API_M8TEC}?${params}`, { Accept: "application/json" }, signal);
      const item = Array.isArray(json) ? json[0] : json;
      const m3u8 = item?.m3u8Url || item?.hlsUrl || item?.videoUrl ||
                   item?.url     || item?.hls_url || item?.stream_url ||
                   item?.variants?.[0]?.url || item?.results?.[0]?.m3u8Url || null;
      if (m3u8) { console.log(`[proxy] ✓ API-1 m8tec: "${q.title}"`); return m3u8; }
    } catch (e) {
      if (signal?.aborted) return null;
      console.warn(`[proxy] API-1 m8tec failed: ${e.message}`);
    }
  }
  return null;
}

// ── Source 2: Apple Music scrape ──────────────────────────
async function fromAppleScrape(artist, title, signal) {
  let collectionId = null;
  try {
    const params = new URLSearchParams({
      term: `${sanitize(title)} ${sanitize(artist)}`, media: "music", entity: "song", limit: "3", country: "us"
    });
    const json = await fetchJson(`${ITUNES_SEARCH}?${params}`, {}, signal);
    collectionId = json.results?.[0]?.collectionId || null;
  } catch (e) {
    if (signal?.aborted) return null;
    console.warn(`[proxy] API-2 iTunes search failed: ${e.message}`);
  }
  if (!collectionId) return null;
  if (signal?.aborted) return null;

  try {
    const html = await fetchText(`https://music.apple.com/us/album/${collectionId}`, {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://music.apple.com/",
    });
    const patterns = [
      /\"contentUrl\"\s*:\s*\"([^\"]+\.m3u8[^\"]*)\"/g,
      /\"hlsUrl\"\s*:\s*\"([^\"]+\.m3u8[^\"]*)\"/g,
      /\"videoUrl\"\s*:\s*\"([^\"]+\.m3u8[^\"]*)\"/g,
      /(https:\/\/[a-z0-9\-]+\.mzstatic\.com\/[^\"'\s]+\.m3u8)/g,
      /(https:\/\/[a-z0-9\-]+\.itunes\.apple\.com\/[^\"'\s]+\.m3u8)/g,
    ];
    for (const pattern of patterns) {
      const m = pattern.exec(html);
      if (m?.[1]) { console.log(`[proxy] ✓ API-2 Apple scrape: "${title}"`); return m[1]; }
    }
  } catch (e) {
    if (signal?.aborted) return null;
    console.warn(`[proxy] API-2 scrape failed: ${e.message}`);
  }
  return null;
}

// ── Race: return first non-null result, batalkan yang kalah ─
function raceFirstAbortable(factories) {
  return new Promise(resolve => {
    const ac      = new AbortController();
    const signal  = ac.signal;
    let settled   = 0, resolved = false;
    const total   = factories.length;
    if (total === 0) { resolve(null); return; }
    factories.forEach(factory => {
      Promise.resolve(factory(signal)).then(val => {
        settled++;
        if (!resolved && val != null) {
          resolved = true;
          ac.abort();
          resolve(val);
        } else if (settled === total && !resolved) resolve(null);
      }).catch(() => {
        settled++;
        if (settled === total && !resolved) resolve(null);
      });
    });
  });
}

async function resolveM3u8(artist, album, title) {
  const cacheKey = `${sanitize(artist)}|${sanitize(album)}|${sanitize(title)}`;
  const cached   = cache.get(cacheKey);
  if (cached) {
    const age = Date.now() - cached.ts;
    if (age < (cached.m3u8 ? CACHE_TTL_MS : CACHE_NONE_MS)) {
      console.log(`[proxy] cache hit: "${title}" → ${cached.m3u8 ? "✓" : "none"}`);
      return cached.m3u8;
    }
  }

  console.log(`[proxy] searching 2 APIs in parallel: "${title}" — ${artist}`);
  const m3u8 = await raceFirstAbortable([
    signal => fromM8tec(artist, album, title, signal),
    signal => fromAppleScrape(artist, title, signal),
  ]);

  cache.set(cacheKey, { m3u8: m3u8 || null, ts: Date.now() });
  console.log(m3u8 ? `[proxy] ✓ resolved: "${title}"` : `[proxy] ✗ no artwork: "${title}"`);
  return m3u8;
}

// ── M3U8 playlist parsing ──────────────────────────────────
const resolveBase = url => url.substring(0, url.lastIndexOf("/") + 1);

function resolveUrl(rawUrl, baseUrl) {
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) return rawUrl;
  try { return new URL(rawUrl, baseUrl).href; } catch { return baseUrl + rawUrl; }
}

async function resolveFirstSegments(m3u8Url, maxSegs = 1) {
  const base = resolveBase(m3u8Url);
  let text;
  try {
    text = await fetchText(m3u8Url);
  } catch (e) {
    throw new Error(`Failed to fetch playlist: ${e.message} → ${m3u8Url.slice(0, 80)}`);
  }

  console.log(`[proxy] playlist preview: ${text.split("\n").slice(0, 8).join(" | ").slice(0, 200)}`);
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  if (text.includes("#EXT-X-STREAM-INF")) {
    const streams = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
      const bw  = parseInt(lines[i].match(/BANDWIDTH=(\d+)/)?.[1]  || "0");
      const h   = parseInt(lines[i].match(/RESOLUTION=\d+x(\d+)/)?.[1] || "0");
      let uriLine = lines[i + 1];
      const uriInTag = lines[i].match(/URI="([^"]+)"/)?.[1];
      if (uriInTag) uriLine = uriInTag;
      if (!uriLine || uriLine.startsWith("#")) continue;
      streams.push({ bw, h, u: resolveUrl(uriLine, base) });
    }

    if (streams.length === 0)
      throw new Error(`No valid streams in master playlist: ${m3u8Url.slice(0, 80)}`);

    let chosen;
    const res = selectedResolution;
    if (!res || res.height === null) {
      streams.sort((a, b) => b.bw - a.bw);
      chosen = streams[0];
      console.log(`[proxy] master: best quality (${chosen.h}p, ${chosen.bw}bps)`);
    } else {
      streams.sort((a, b) => {
        const da = Math.abs(a.h - res.height), db = Math.abs(b.h - res.height);
        return da !== db ? da - db : b.bw - a.bw;
      });
      chosen = streams[0];
      console.log(`[proxy] master: ${chosen.h}p (target: ${res.height}p, bw: ${chosen.bw})`);
    }

    console.log(`[proxy] media playlist: ${chosen.u.slice(0, 100)}`);
    return resolveFirstSegments(chosen.u, maxSegs);
  }

  const segs = lines
    .filter(l => !l.startsWith("#") && (l.includes("/") || l.includes(".") || l.includes("?")))
    .map(l => resolveUrl(l, base));

  console.log(`[proxy] ${segs.length} segments found`);
  if (segs.length > 0) console.log(`[proxy] seg[0]: ${segs[0].slice(0, 100)}`);
  else console.warn(`[proxy] ⚠ No segments found! Lines: ${lines.slice(0, 10).join(" | ")}`);

  return maxSegs > 0 ? segs.slice(0, maxSegs) : segs;
}

// ── GPU decoder detection ──────────────────────────────────
let gpuDecoder = null;

async function detectGpuDecoder() {
  const run = args => new Promise(resolve => {
    const ff = spawn("ffmpeg", args);
    let out = "";
    ff.stdout.on("data", d => out += d);
    ff.stderr.on("data", d => out += d);
    ff.on("close", () => resolve(out.toLowerCase()));
    ff.on("error", () => resolve(""));
  });

  const hwaccels = await run(["-hide_banner", "-hwaccels"]);
  const decoders = await run(["-hide_banner", "-decoders"]);

  if (decoders.includes("h264_cuvid")  && hwaccels.includes("cuda"))         return { hwaccel: "cuda",         label: "NVIDIA CUDA" };
  if (decoders.includes("h264_qsv")    && hwaccels.includes("qsv"))          return { hwaccel: "qsv",          label: "Intel Quick Sync (QSV)" };
  if (hwaccels.includes("d3d11va"))                                           return { hwaccel: "d3d11va",      label: "AMD/Intel D3D11VA" };
  if (hwaccels.includes("videotoolbox"))                                      return { hwaccel: "videotoolbox", label: "Apple VideoToolbox" };
  return false;
}

// ── Encoder detection ──────────────────────────────────────
let availableEncoder = null;

async function detectEncoder() {
  const encoders = await new Promise(resolve => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-encoders"]);
    let out = "";
    ff.stdout.on("data", d => out += d);
    ff.stderr.on("data", d => out += d);
    ff.on("close", () => resolve(out.toLowerCase()));
    ff.on("error", () => resolve(""));
  });

  if (encoders.includes("libvpx-vp9")) {
    console.log("✅ VP9 encoder (libvpx-vp9) available");
    return "vp9";
  }
  console.error("❌ libvpx-vp9 not found in this ffmpeg build!");
  console.error("   Install full ffmpeg: winget install ffmpeg");
  process.exit(1);
}

// ── ffmpeg args builder ────────────────────────────────────
function buildFfmpegArgs(gpu, height) {
  const args        = ["-loglevel", "error"];
  const cpuThreads  = Math.max(1, require("os").cpus().length);

  if (gpu) {
    if      (gpu.hwaccel === "cuda")         args.push("-hwaccel", "cuda");
    else if (gpu.hwaccel === "d3d11va")      args.push("-hwaccel", "d3d11va");
    else if (gpu.hwaccel === "qsv")          args.push("-hwaccel", "qsv");
    else if (gpu.hwaccel === "videotoolbox") args.push("-hwaccel", "videotoolbox");
  }

  args.push("-threads", String(cpuThreads), "-i", "pipe:0");

  if (height) args.push("-vf", `scale=-2:${height},format=yuv420p`);
  else        args.push("-vf", "format=yuv420p");

  const isUltraHigh = !height || height > 720;
  const isHighRes   = height >= 720;

  const tileColumns  = isUltraHigh ? "6" : (isHighRes ? "5" : "4");
  const tileRows     = "2";
  const crf          = isUltraHigh ? "36" : (isHighRes ? "34" : "33");

  args.push(
    "-c:v",            "libvpx-vp9",
    "-deadline",       "realtime",
    "-cpu-used",       "8",
    "-crf",            crf,
    "-b:v",            "0",
    "-lag-in-frames",  "0",
    "-row-mt",         "1",
    "-tile-columns",   tileColumns,
    "-tile-rows",      tileRows,
    "-frame-parallel", "1",
    "-error-resilient","1",
    "-threads",        String(cpuThreads),
    "-an", "-f", "webm", "pipe:1"
  );

  return args;
}


function runFfmpegPipeSegment(segUrl, ffArgs, res, req) {
  return new Promise(async (resolve, reject) => {
    let aborted = false;
    const ff    = spawn("ffmpeg", ffArgs);
    const chunks = [];

    // Jika client disconnect, kill ffmpeg langsung
    const onClientClose = () => {
      if (aborted) return;
      aborted = true;
      console.log("[proxy] client disconnected — killing ffmpeg");
      try { ff.kill("SIGKILL"); } catch (_) {}
      reject(new Error("client disconnected"));
    };
    req?.on("close", onClientClose);

    // Header response sebelum ffmpeg mulai (MSE-ready)
    res.writeHead(200, {
      "Content-Type"     : "video/webm",
      "Transfer-Encoding": "chunked",
      "Cache-Control"    : "no-store",
      "X-Cache"          : "MISS",
    });

    ff.stdout.on("data", chunk => {
      if (aborted) return;
      chunks.push(chunk);
      if (!res.writableEnded) res.write(chunk);
    });
    ff.stderr.on("data", d => { if (!aborted) process.stderr.write("[ffmpeg] " + d); });

    ff.on("close", code => {
      req?.off("close", onClientClose);
      if (!res.writableEnded) res.end();
      if (aborted) return;
      if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code} (chunks: ${chunks.length})`));
    });

    ff.on("error", err => {
      req?.off("close", onClientClose);
      if (!res.writableEnded) res.end();
      if (aborted) return;
      reject(err.code === "ENOENT"
        ? new Error("ffmpeg not found in PATH. Install: winget install ffmpeg")
        : err);
    });

    ff.stdin.on("error", err => {
      if (err.code !== "EPIPE" && err.code !== "EOF") {
        // Tidak reject — stdin tutup lebih awal saat segment selesai, ini normal
      }
    });

    // Mulai fetch segment dan pipe langsung ke ffmpeg stdin
    try {
      const segStream = await fetchStream(segUrl);
      // Pipe HTTP response stream → ffmpeg stdin
      segStream.pipe(ff.stdin);
      segStream.on("error", err => {
        if (!aborted) {
          try { ff.kill("SIGKILL"); } catch (_) {}
          reject(new Error(`Segment fetch error: ${err.message}`));
        }
      });
    } catch (e) {
      if (!aborted) {
        try { ff.stdin.end(); ff.kill("SIGKILL"); } catch (_) {}
        reject(e);
      }
    }
  });
}

// ── runFfmpegStream: fallback (buffer dulu) ────────────────
// Dipakai saat in-flight dedup (tidak bisa pipe ulang)
function runFfmpegStream(ffArgs, inputBuf, res, req) {
  return new Promise((resolve, reject) => {
    const ff     = spawn("ffmpeg", ffArgs);
    const chunks = [];
    let   aborted = false;

    const onClientClose = () => {
      if (aborted) return;
      aborted = true;
      console.log("[proxy] client disconnected — killing ffmpeg");
      try { ff.kill("SIGKILL"); } catch (_) {}
      reject(new Error("client disconnected"));
    };
    req?.on("close", onClientClose);

    res.writeHead(200, {
      "Content-Type"    : "video/webm",
      "Transfer-Encoding": "chunked",
      "Cache-Control"   : "no-store",
      "X-Cache"         : "MISS",
    });

    ff.stdout.on("data", chunk => {
      if (aborted) return;
      chunks.push(chunk);
      if (!res.writableEnded) res.write(chunk);
    });
    ff.stderr.on("data", d => { if (!aborted) process.stderr.write("[ffmpeg] " + d); });

    ff.on("close", code => {
      req?.off("close", onClientClose);
      if (!res.writableEnded) res.end();
      if (aborted) return;
      if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code} (chunks: ${chunks.length})`));
    });

    ff.on("error", err => {
      req?.off("close", onClientClose);
      if (!res.writableEnded) res.end();
      if (aborted) return;
      reject(err.code === "ENOENT"
        ? new Error("ffmpeg not found in PATH. Install: winget install ffmpeg")
        : err);
    });

    ff.stdin.on("error", err => {
      if (err.code !== "EPIPE" && err.code !== "EOF") reject(err);
    });

    try { ff.stdin.write(inputBuf); ff.stdin.end(); }
    catch (e) { /* stdin closed early, wait for close event */ }
  });
}

// ── runFfmpeg: buffer mode (untuk pre-transcode tanpa HTTP res) ─
function runFfmpeg(ffArgs, inputBuf) {
  return new Promise((resolve, reject) => {
    const ff     = spawn("ffmpeg", ffArgs);
    const chunks = [];

    ff.stdout.on("data", c => chunks.push(c));
    ff.stderr.on("data", d => process.stderr.write("[ffmpeg] " + d));

    ff.on("close", code => {
      if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code} (chunks: ${chunks.length})`));
    });

    ff.on("error", err => {
      reject(err.code === "ENOENT"
        ? new Error("ffmpeg not found in PATH. Install: winget install ffmpeg")
        : err);
    });

    ff.stdin.on("error", err => {
      if (err.code !== "EPIPE" && err.code !== "EOF") reject(err);
    });

    try { ff.stdin.write(inputBuf); ff.stdin.end(); }
    catch (e) { /* stdin closed early */ }
  });
}

// ── NEW: prewarmTranscode ──────────────────────────────────
// Dipanggil segera setelah /artwork resolve m3u8.
// Download + transcode di background → hasil masuk ke webmCache.
// Saat extension memanggil /transcode, hasilnya sudah ada (cache HIT) atau hampir selesai.
async function prewarmTranscode(m3u8Url) {
  // Jika sudah di-cache atau sedang in-flight, tidak perlu ulang
  const cached = webmCache.get(m3u8Url);
  if (cached && (Date.now() - cached.ts) < WEBM_CACHE_TTL_MS) {
    console.log(`[proxy] prewarm: webm cache already warm`);
    return;
  }
  if (inFlight.has(m3u8Url)) {
    console.log(`[proxy] prewarm: transcode already in-flight`);
    return;
  }

  console.log(`[proxy] 🔥 prewarm: starting background transcode`);

  const transcodePromise = (async () => {
    try {
      const segs = await resolveFirstSegments(m3u8Url, 1);
      if (segs.length === 0) throw new Error("No segments");

      const tsBuf = await fetchBuf(segs[0], {}, 6);
      const gpu   = gpuDecoder || null;
      const webm  = await runFfmpeg(buildFfmpegArgs(gpu, selectedResolution?.height ?? null), tsBuf);
      webmCacheSet(m3u8Url, webm);
      console.log(`[proxy] 🔥 prewarm: done (${(webm.length / 1024).toFixed(0)} KB cached)`);
      return webm;
    } catch (e) {
      console.warn(`[proxy] prewarm failed: ${e.message}`);
      throw e;
    }
  })();

  inFlight.set(m3u8Url, transcodePromise);
  transcodePromise.finally(() => inFlight.delete(m3u8Url));
}

// ── HTTP Server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = new URL(req.url, `http://localhost:${PORT}`);

  // GET /ping
  if (parsed.pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status    : "ok",
      version   : "v3",
      resolution: selectedResolution?.label || "original (full quality)",
      decode    : gpuDecoder ? `GPU: ${gpuDecoder.label}` : "CPU only",
      encode    : "libvpx-vp9 (VP9, realtime)",
      sources   : ["m8tec", "Apple-scrape"],
      cache     : { m3u8_entries: cache.size, webm_entries: webmCache.size, webm_max: WEBM_CACHE_MAX },
    }));
    return;
  }

  // GET /artwork
  if (parsed.pathname === "/artwork") {
    const artist = parsed.searchParams.get("artist") || "";
    const album  = parsed.searchParams.get("album")  || "";
    const title  = parsed.searchParams.get("title")  || "";

    if (!artist && !title) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing artist or title" }));
      return;
    }
    try {
      const m3u8 = await resolveM3u8(artist, album, title);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ m3u8: m3u8 || null }));

      // ── NEW: Segera prewarm transcode setelah m3u8 ditemukan ──
      // Tidak tunggu response /transcode dari extension
      if (m3u8) {
        setImmediate(() => prewarmTranscode(m3u8).catch(() => {}));
      }
    } catch (e) {
      console.error("[proxy] /artwork error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /transcode
  if (parsed.pathname === "/transcode") {
    const m3u8Url = parsed.searchParams.get("url");
    if (!m3u8Url || m3u8Url === "null" || m3u8Url === "undefined") {
      res.writeHead(400); res.end("Missing or invalid ?url="); return;
    }
    try { new URL(m3u8Url); } catch (_) {
      res.writeHead(400); res.end(`Invalid URL: ${m3u8Url.slice(0, 80)}`); return;
    }

    try {
      // 1. WebM cache HIT → kirim langsung (paling cepat, sudah prewarm)
      const cached = webmCache.get(m3u8Url);
      if (cached && (Date.now() - cached.ts) < WEBM_CACHE_TTL_MS) {
        cached.hitCount++;
        if (cached.hitCount === 1)
          console.log(`[proxy] ✓ webm cache hit (${(cached.webm.length / 1024).toFixed(0)} KB)`);
        res.writeHead(200, {
          "Content-Type"  : "video/webm",
          "Content-Length": cached.webm.length,
          "Cache-Control" : "no-store",
          "X-Cache"       : "HIT",
        });
        res.end(cached.webm);
        return;
      }

      // 2. In-flight dedup (prewarm sedang jalan) → tunggu, lalu stream hasilnya
      if (inFlight.has(m3u8Url)) {
        console.log(`[proxy] ⏳ prewarm in-flight — joining and streaming result`);
        const webm = await inFlight.get(m3u8Url);
        res.writeHead(200, {
          "Content-Type"  : "video/webm",
          "Content-Length": webm.length,
          "Cache-Control" : "no-store",
          "X-Cache"       : "PREWARM",
        });
        res.end(webm);
        return;
      }

      // 3. Cold start: pipe segment langsung ke ffmpeg (tidak buffer seluruh segment)
      console.log(`[proxy] ❄ cold transcode (pipe): ${m3u8Url.slice(0, 80)}...`);
      const t0 = Date.now();

      let segs;
      for (let attempt = 1; attempt <= 6; attempt++) {
        try { segs = await resolveFirstSegments(m3u8Url, 1); break; }
        catch (e) {
          const retryable = e.message.includes("ECONNRESET") || e.message.includes("Timeout") ||
                            e.message.includes("ECONNREFUSED");
          if (!retryable || attempt === 6) throw e;
          console.warn(`[proxy] playlist retry ${attempt}/5 (${e.message.slice(0, 50)})`);
          await new Promise(r => setTimeout(r, 80 + attempt * 40));
        }
      }
      if (!segs || segs.length === 0) throw new Error("No segments found in playlist");

      console.log(`[proxy] playlist resolve: ${Date.now() - t0}ms — piping segment directly to ffmpeg`);

      const gpu   = gpuDecoder || null;
      const ffArgs = buildFfmpegArgs(gpu, selectedResolution?.height ?? null);

      // ── Pipe segment stream langsung ke ffmpeg (tidak tunggu download selesai)
      const transcodePromise = runFfmpegPipeSegment(segs[0], ffArgs, res, req)
        .then(webm => {
          console.log(`[proxy] ✓ cold transcode done: ${(webm.length / 1024).toFixed(0)} KB (${Date.now() - t0}ms total)`);
          webmCacheSet(m3u8Url, webm);
          return webm;
        });

      inFlight.set(m3u8Url, transcodePromise);
      try {
        await transcodePromise;
      } finally {
        inFlight.delete(m3u8Url);
      }
      return;

    } catch (e) {
      console.error("[proxy] transcode error:", e.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Error: ${e.message}`);
      }
    }
    return;
  }

  // GET /cache/clear
  if (parsed.pathname === "/cache/clear") {
    const m3u8Count = cache.size, webmCount = webmCache.size;
    cache.clear(); webmCache.clear();
    console.log(`[proxy] cache cleared — m3u8: ${m3u8Count}, webm: ${webmCount} entries`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`Cache cleared (m3u8: ${m3u8Count}, webm: ${webmCount} entries removed)`);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ── Startup ────────────────────────────────────────────────
(async () => {
  await pickResolution();

  console.log("\n🔍 Detecting VP9 encoder...");
  availableEncoder = await detectEncoder();

  console.log("\n🔍 Detecting GPU decoder...");
  gpuDecoder = await detectGpuDecoder();
  if (gpuDecoder) {
    console.log(`✅ GPU Decoder: ${gpuDecoder.label}`);
    console.log(`   H.264 decode → GPU | VP9 encode → CPU`);
  } else {
    console.log(`ℹ️  No GPU decoder found → CPU only`);
  }

  server.listen(PORT, "127.0.0.1", () => {
    const decodeMode = gpuDecoder ? `GPU (${gpuDecoder.label})` : "CPU only";
    console.log(`\n✅ animart-proxy v3 running at http://localhost:${PORT}`);
    console.log(`   Resolution : ${selectedResolution?.label || "720p default"}`);
    console.log(`   Encoder    : VP9 (libvpx-vp9)`);
    console.log(`   Decode     : ${decodeMode}`);
    console.log(`   Segments   : 1 (hemat kuota)`);
    console.log(`   Pipe mode  : segment → ffmpeg direct (no buffer wait)`);
    console.log(`   Pre-warm   : ✓ transcode starts immediately after /artwork resolves`);
    console.log(`   Health     : http://localhost:${PORT}/ping`);
    console.log(`   Artwork    : http://localhost:${PORT}/artwork?artist=Drake&title=Nokia`);
    console.log(`   Transcode  : http://localhost:${PORT}/transcode?url=<m3u8_url>`);
    console.log(`\n📡 2 APIs searched in parallel (fastest wins):`);
    console.log(`   API-1: artwork.m8tec.top`);
    console.log(`   API-2: iTunes Search + Apple Music scrape`);
    console.log(`\n🗃  WebM Cache: max ${WEBM_CACHE_MAX} tracks, TTL 2h`);
    console.log(`⚡ v3 optimizations: prewarm + direct pipe + MSE streaming`);
    console.log(`💡 Tip: node animart-proxy.js 1080  → use 1080p directly`);
    console.log(`⚠  Requires ffmpeg: winget install ffmpeg\n`);
  });

  server.on("error", e => {
    if (e.code === "EADDRINUSE")
      console.error(`❌ Port ${PORT} already in use. Close other process or change PORT.`);
    else
      console.error("Server error:", e.message);
    process.exit(1);
  });
})();
