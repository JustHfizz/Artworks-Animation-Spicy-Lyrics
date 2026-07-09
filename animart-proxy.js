
const http      = require("http");
const https     = require("https");
const { spawn } = require("child_process");
const readline  = require("readline");
const { PassThrough } = require("stream");
const os        = require("os");
const path      = require("path");
const fs        = require("fs");

const GITHUB_RAW_BASE   = "https://raw.githubusercontent.com/JustHfizz/Artworks-Animation-Spicy-Lyrics/main";
const GITHUB_API_REPO   = "https://api.github.com/repos/JustHfizz/Artworks-Animation-Spicy-Lyrics/commits?per_page=1&path=";
const SCRIPT_DIR        = __dirname;
const PROXY_FILENAME    = "animart-proxy.js";
const EXT_FILENAME      = "animated-artwork.mjs";
const CONFIG_PATH       = path.join(SCRIPT_DIR, "animart-config.json");




const DEBUG = process.argv.includes("--debug") || process.env.ANIMART_DEBUG === "1";
function dlog(...args)  { if (DEBUG) console.log(...args); }
function dwarn(...args) { if (DEBUG) console.warn(...args); }





const BAR_WIDTH = 22;
function drawBar(pct) {
  const p      = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const filled = Math.round((p / 100) * BAR_WIDTH);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}] ${String(p).padStart(3)}%`;
}

const STATUS_LABEL = {
  searching : "searching source…",
  found     : "source found",
  notfound  : "not found",
  ready     : "ready",
  failed    : "failed",
};

class TrackBoard {
  constructor() {
    this.tracks       = new Map();  
    this.order        = [];
    this.linesPrinted = 0;
    this.seq          = 0;
    this.enabled      = process.stdout.isTTY === true;
    this._renderTimer = null;
  }

  add(artist, title, album) {
    const id = `t${++this.seq}`;
    this.tracks.set(id, {
      artist: artist || "Unknown Artist",
      title : title  || "Unknown Title",
      album : album  || "-",
      source: null,
      status: "searching",
      downloadPct : 0,
      transcodePct: 0,
      note: "",
    });
    this.order.push(id);
    this._trim();
    this.render();
    return id;
  }

  update(id, patch) {
    if (!id) return;
    const t = this.tracks.get(id);
    if (!t) return;
    Object.assign(t, patch);
    this._scheduleRender();
  }

  finish(id, ok, note) {
    if (!id) return;
    const t = this.tracks.get(id);
    if (!t) return;
    t.status = ok ? "ready" : "failed";
    if (note) t.note = note;
    if (ok) { t.downloadPct = 100; t.transcodePct = 100; }
    this.render();
  }

  _trim() {
    const MAX_ROWS = 6;
    while (this.order.length > MAX_ROWS) {
      const oldest = this.order.shift();
      this.tracks.delete(oldest);
    }
  }

  _lines() {
    const W = 64;
    const rule = "─".repeat(W);
    const lines = [rule, "🎵  ANIMART PROXY — Now Playing / Queue", rule];
    if (this.order.length === 0) {
      lines.push("   (waiting for a song...)");
    }
    for (const id of this.order) {
      const t = this.tracks.get(id);
      if (!t) continue;
      const src = t.source ? t.source : STATUS_LABEL[t.status] || "";
      const tail = t.status === "notfound" || t.status === "failed"
        ? `  ✗ ${t.note || STATUS_LABEL[t.status]}`
        : t.status === "ready" ? "  ✓ cached" : "";
      lines.push(`Song      : ${t.title}`);
      lines.push(`Album     : ${t.album}`);
      lines.push(`Artist    : ${t.artist}`);
      lines.push(`Source    : ${src}${tail}`);
      lines.push(`Download  : ${drawBar(t.downloadPct)}`);
      lines.push(`Transcode : ${drawBar(t.transcodePct)}`);
      lines.push("");
    }
    lines.push(rule);
    return lines;
  }

  // Rate-limit redraws during rapid progress events (download/transcode fire
  // many times a second) so the console isn't hammered with writes.
  _scheduleRender() {
    if (!this.enabled || this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this.render();
    }, 120);
  }

  pause() {
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    if (!this.enabled || this.linesPrinted === 0) return;
    readline.moveCursor(process.stdout, 0, -this.linesPrinted);
    readline.clearScreenDown(process.stdout);
    this.linesPrinted = 0;
  }

  render() {
    if (!this.enabled) return;
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    const lines = this._lines();
    if (this.linesPrinted > 0) {
      readline.moveCursor(process.stdout, 0, -this.linesPrinted);
      readline.clearScreenDown(process.stdout);
    }
    process.stdout.write(lines.join("\n") + "\n");
    this.linesPrinted = lines.length;
  }
}

const board       = new TrackBoard();
const m3u8ToTrack = new Map(); 

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.warn(`[config] could not read ${CONFIG_PATH}: ${e.message}`);
  }
  return {};
}

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

let currentExtensionHash = null;

function loadExtensionHash() {
  try {
    const extPath = path.join(SCRIPT_DIR, EXT_FILENAME);
    if (fs.existsSync(extPath)) {
      const code = fs.readFileSync(extPath, "utf8");
      currentExtensionHash = djb2(code);
      console.log(`[update] extension hash loaded: ${currentExtensionHash}`);
    }
  } catch (e) {
    console.warn(`[update] could not read extension file: ${e.message}`);
  }
}

function fetchGitHub(url) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req  = https.get({
      hostname: opts.hostname,
      path    : opts.pathname + opts.search,
      headers : {
        "User-Agent": "animart-proxy-updater/1.0",
        "Accept"    : "application/vnd.github.v3+json, text/plain, */*",
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(fetchGitHub(res.headers.location));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("GitHub fetch timeout")); });
  });
}

async function checkFileUpdate(filename) {
  const localPath = path.join(SCRIPT_DIR, filename);
  let localMtime  = 0;
  try {
    if (fs.existsSync(localPath)) localMtime = fs.statSync(localPath).mtimeMs;
  } catch (_) {}

  try {
    const apiUrl = GITHUB_API_REPO + encodeURIComponent(filename);
    const { status, body } = await fetchGitHub(apiUrl);
    if (status !== 200) return { hasUpdate: false };

    const commits = JSON.parse(body);
    if (!commits || commits.length === 0) return { hasUpdate: false };

    const latestCommit = commits[0];
    const commitDate   = new Date(latestCommit.commit?.committer?.date || latestCommit.commit?.author?.date);
    const commitSha    = latestCommit.sha?.slice(0, 7) || "?";
    const commitMsg    = latestCommit.commit?.message?.split("\n")[0] || "";

    const rawUrl = `${GITHUB_RAW_BASE}/${filename}`;
    const { status: rawStatus, body: remoteCode } = await fetchGitHub(rawUrl);
    if (rawStatus !== 200 || !remoteCode) return { hasUpdate: false };

    const remoteHash = djb2(remoteCode);
    let   localHash  = null;
    try {
      if (fs.existsSync(localPath)) localHash = djb2(fs.readFileSync(localPath, "utf8"));
    } catch (_) {}

    const hasUpdate = localHash !== remoteHash;
    return { hasUpdate, commitSha, commitMsg, commitDate, remoteCode, remoteHash };
  } catch (e) {
    console.warn(`[update] could not check ${filename}: ${e.message}`);
    return { hasUpdate: false };
  }
}

async function runStartupUpdateCheck() {
  console.log("\n🔄 Checking for updates on GitHub...");

  const proxyResult = await checkFileUpdate(PROXY_FILENAME);

  if (!proxyResult.hasUpdate) {
    console.log("✅ Proxy is already up to date.\n");
    return;
  }

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  ⚠  UPDATE AVAILABLE on GitHub!                      ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  📦 animart-proxy.js — commit ${proxyResult.commitSha?.padEnd(7)}                  ║`);
  if (proxyResult.commitMsg)
    console.log(`║     └─ "${proxyResult.commitMsg.slice(0, 45).padEnd(45)}"  ║`);

  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  How to update:                                      ║");
  console.log("║   1. Download the latest file from:                  ║");
  console.log("║      https://github.com/JustHfizz/Artworks-          ║");
  console.log("║             Animation-Spicy-Lyrics                   ║");
  console.log("║   2. Replace the old file with the new one           ║");
  console.log("║   3. Restart: node animart-proxy.js                  ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  [Enter] Continue without updating   [Q] Quit        ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const answer = await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Your choice [Enter/Q]: ", ans => { rl.close(); resolve(ans.trim().toLowerCase()); });

    setTimeout(() => { rl.close(); resolve(""); }, 30000);
  });

  if (answer === "q" || answer === "quit" || answer === "exit") {
    console.log("\n🛑 Proxy stopped. Update the file and restart.\n");
    process.exit(0);
  }

  console.log(`\n⚠  ${PROXY_FILENAME} needs to be updated manually (can't self-replace while running).`);
  console.log(`   Download from: ${GITHUB_RAW_BASE}/${PROXY_FILENAME}`);
  console.log("\n▶ Continuing with the current version...\n");
}

function parseMultipart(body, boundary) {
  const parts = [];
  const sep   = Buffer.from("--" + boundary);
  const end   = Buffer.from("--" + boundary + "--");
  let pos = 0;

  while (pos < body.length) {
    const boundStart = body.indexOf(sep, pos);
    if (boundStart === -1) break;
    pos = boundStart + sep.length;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (body[pos] === 0x0a) pos += 1;
    else break;

    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), pos);
    if (headerEnd === -1) break;
    const headerStr = body.slice(pos, headerEnd).toString("utf8");
    pos = headerEnd + 4;

    const nextBound = body.indexOf(sep, pos);
    if (nextBound === -1) break;
    let dataEnd = nextBound;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
    else if (body[dataEnd - 1] === 0x0a) dataEnd -= 1;

    const data = body.slice(pos, dataEnd);
    pos = nextBound;

    const cdMatch  = headerStr.match(/Content-Disposition:[^\r\n]*/i)?.[0] || "";
    const nameM    = cdMatch.match(/name="([^"]+)"/)?.[1] || "";
    const fileM    = cdMatch.match(/filename="([^"]+)"/)?.[1] || "";
    const ctMatch  = headerStr.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim() || "";
    parts.push({ name: nameM, filename: fileM, contentType: ctMatch, data });
  }
  return parts;
}

const PORT = 7799;

const RESOLUTION_OPTIONS = {
  "720" : { label: "720p  — HD (default)",               height: 720,  bitrate: "0" },
  "1080": { label: "1080p — Full HD, max quality",        height: 1080, bitrate: "0" },
  "best": { label: "Best  — highest quality (auto res)",  height: null, bitrate: "0" },
};

const BEST_MODE_MAX_HEIGHT = 1600;

function buildScaleFilter(targetHeight) {
  const h = targetHeight ?? BEST_MODE_MAX_HEIGHT;

  return `scale=-2:min(ih\\,${h}),format=yuv420p`;
}

let selectedResolution = null;

async function pickResolution() {
  const arg    = process.argv[2]?.toLowerCase()?.trim();
  const config = loadConfig();

  if (arg && RESOLUTION_OPTIONS[arg]) {
    selectedResolution = RESOLUTION_OPTIONS[arg];
    console.log(`\n🎬 Resolution: ${selectedResolution.label}`);
    return;
  }
  if (arg) console.warn(`\n⚠  Unknown resolution "${arg}".`);

  if (config.resolution && RESOLUTION_OPTIONS[config.resolution]) {
    selectedResolution = RESOLUTION_OPTIONS[config.resolution];
    console.log(`\n🎬 Resolution (saved): ${selectedResolution.label}`);
    return;
  }

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

const API_M8TEC     = "https://artwork.m8tec.top/api/v1/artwork/search";
const ITUNES_SEARCH = "https://itunes.apple.com/search";

const cache          = new Map();
const CACHE_TTL_MS   = 24 * 60 * 60 * 1000;
const CACHE_NONE_MS  =  4 * 60 * 60 * 1000;

const webmCache         = new Map();
const WEBM_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const WEBM_CACHE_MAX    = 10;

function webmCacheSet(key, webmBuf) {
  if (webmCache.size >= WEBM_CACHE_MAX) {
    webmCache.delete(webmCache.keys().next().value);
    dlog(`[proxy] webm cache full — evicted oldest entry`);
  }
  webmCache.set(key, { webm: webmBuf, ts: Date.now(), hitCount: 0 });
  dlog(`[proxy] webm cache: saved (${(webmBuf.length / 1024).toFixed(0)} KB), entries: ${webmCache.size}`);
}

const inFlight = new Map();

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
      dwarn(`[proxy] retry ${attempt}/${maxRetry - 1} (${e.code || e.message.slice(0, 30)}): ${targetUrl.slice(0, 60)}`);
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastErr;
}

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


async function fetchBufWithProgress(targetUrl, extraHeaders = {}, onProgress) {
  const stream = await fetchStream(targetUrl);
  const total  = parseInt(stream.headers?.["content-length"] || "0", 10);
  let received = 0;
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on("data", chunk => {
      chunks.push(chunk);
      received += chunk.length;
      if (onProgress) onProgress(total > 0 ? Math.min(99, (received / total) * 100) : 0);
    });
    stream.on("end", () => { if (onProgress) onProgress(100); resolve(Buffer.concat(chunks)); });
    stream.on("error", reject);
  });
}

function sanitize(str) {
  if (!str) return "";
  return str
    .replace(/\$/g, "S")
    .replace(/[&+#%@=]/g, " ")
    .replace(/[^\w\s\-'.,()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
      if (m3u8) { dlog(`[proxy] ✓ API-1 m8tec: "${q.title}"`); return m3u8; }
    } catch (e) {
      if (signal?.aborted) return null;
      dwarn(`[proxy] API-1 m8tec failed: ${e.message}`);
    }
  }
  return null;
}

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
    dwarn(`[proxy] API-2 iTunes search failed: ${e.message}`);
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
      if (m?.[1]) { dlog(`[proxy] ✓ API-2 Apple scrape: "${title}"`); return m[1]; }
    }
  } catch (e) {
    if (signal?.aborted) return null;
    dwarn(`[proxy] API-2 scrape failed: ${e.message}`);
  }
  return null;
}

function raceFirstAbortable(factories) {
  return new Promise(resolve => {
    const ac      = new AbortController();
    const signal  = ac.signal;
    let settled   = 0, resolved = false;
    const total   = factories.length;
    if (total === 0) { resolve({ m3u8: null, source: null }); return; }
    factories.forEach(({ label, fn }) => {
      Promise.resolve(fn(signal)).then(val => {
        settled++;
        if (!resolved && val != null) {
          resolved = true;
          ac.abort();
          resolve({ m3u8: val, source: label });
        } else if (settled === total && !resolved) resolve({ m3u8: null, source: null });
      }).catch(() => {
        settled++;
        if (settled === total && !resolved) resolve({ m3u8: null, source: null });
      });
    });
  });
}

async function resolveM3u8(artist, album, title, boardId) {
  const cacheKey = `${sanitize(artist)}|${sanitize(album)}|${sanitize(title)}`;
  const cached   = cache.get(cacheKey);
  if (cached) {
    const age = Date.now() - cached.ts;
    if (age < (cached.m3u8 ? CACHE_TTL_MS : CACHE_NONE_MS)) {
      dlog(`[proxy] cache hit: "${title}" → ${cached.m3u8 ? "✓" : "none"} (${cached.source || "?"})`);
      board.update(boardId, {
        source: cached.source ? `${cached.source} (cache)` : "cache",
        status: cached.m3u8 ? "found" : "notfound",
      });
      return { m3u8: cached.m3u8 || null, source: cached.source || null };
    }
  }

  dlog(`[proxy] searching 2 APIs in parallel: "${title}" — ${artist}`);
  const { m3u8, source } = await raceFirstAbortable([
    { label: "m8tec",  fn: signal => fromM8tec(artist, album, title, signal) },
    { label: "apple",  fn: signal => fromAppleScrape(artist, title, signal)  },
  ]);

  cache.set(cacheKey, { m3u8: m3u8 || null, source: source || null, ts: Date.now() });
  dlog(m3u8 ? `[proxy] ✓ resolved: "${title}" via ${source}` : `[proxy] ✗ no artwork: "${title}"`);
  board.update(boardId, { source: source || null, status: m3u8 ? "found" : "notfound" });
  return { m3u8: m3u8 || null, source: source || null };
}

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

  dlog(`[proxy] playlist preview: ${text.split("\n").slice(0, 8).join(" | ").slice(0, 200)}`);
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
      dlog(`[proxy] master: best quality (${chosen.h}p, ${chosen.bw}bps)`);
    } else {
      streams.sort((a, b) => {
        const da = Math.abs(a.h - res.height), db = Math.abs(b.h - res.height);
        return da !== db ? da - db : b.bw - a.bw;
      });
      chosen = streams[0];
      dlog(`[proxy] master: ${chosen.h}p (target: ${res.height}p, bw: ${chosen.bw})`);
    }

    dlog(`[proxy] media playlist: ${chosen.u.slice(0, 100)}`);
    return resolveFirstSegments(chosen.u, maxSegs);
  }

  const segs = lines
    .filter(l => !l.startsWith("#") && (l.includes("/") || l.includes(".") || l.includes("?")))
    .map(l => resolveUrl(l, base));

  const durationMatch = text.match(/#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/);
  const duration = durationMatch ? parseFloat(durationMatch[1]) : 6; // fallback estimate (sec)

  dlog(`[proxy] ${segs.length} segments found`);
  if (segs.length > 0) dlog(`[proxy] seg[0]: ${segs[0].slice(0, 100)}`);
  else dwarn(`[proxy] ⚠ No segments found! Lines: ${lines.slice(0, 10).join(" | ")}`);

  return { segs: maxSegs > 0 ? segs.slice(0, maxSegs) : segs, duration };
}

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

function buildFfmpegArgs(gpu, height) {
  const args        = ["-loglevel", "error", "-progress", "pipe:2", "-nostats"];
  const cpuThreads  = Math.max(1, os.cpus().length);

  if (gpu) {
    if      (gpu.hwaccel === "cuda")         args.push("-hwaccel", "cuda");
    else if (gpu.hwaccel === "d3d11va")      args.push("-hwaccel", "d3d11va");
    else if (gpu.hwaccel === "qsv")          args.push("-hwaccel", "qsv");
    else if (gpu.hwaccel === "videotoolbox") args.push("-hwaccel", "videotoolbox");
  }

  args.push("-threads", String(cpuThreads), "-i", "pipe:0");

  args.push("-vf", buildScaleFilter(height));

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


function makeProgressParser(duration, onProgress) {
  if (!onProgress) return () => {};
  let buf = "";
  return chunk => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const outTimeMatch = line.match(/^out_time_ms=(\d+)/) || line.match(/^out_time_us=(\d+)/);
      if (outTimeMatch) {
        const seconds = parseInt(outTimeMatch[1], 10) / 1e6;
        const pct = duration > 0 ? Math.min(99, (seconds / duration) * 100) : 0;
        onProgress(pct);
      } else if (/^progress=end/.test(line)) {
        onProgress(100);
      }
    }
  };
}

function runFfmpegPipeSegment(segUrl, ffArgs, res, req, duration, onDownloadProgress, onTranscodeProgress) {
  return new Promise(async (resolve, reject) => {
    let aborted = false;
    const ff    = spawn("ffmpeg", ffArgs);
    const chunks = [];

    const onClientClose = () => {
      if (aborted) return;
      aborted = true;
      dlog("[proxy] client disconnected — killing ffmpeg");
      try { ff.kill("SIGKILL"); } catch (_) {}
      reject(new Error("client disconnected"));
    };
    req?.on("close", onClientClose);

    res.writeHead(200, {
      "Content-Type"     : "video/webm",
      "Transfer-Encoding": "chunked",
      "Cache-Control"    : "no-store",
      "X-Cache"          : "MISS",
    });

    const parseProgress = makeProgressParser(duration, onTranscodeProgress);

    ff.stdout.on("data", chunk => {
      if (aborted) return;
      chunks.push(chunk);
      if (!res.writableEnded) res.write(chunk);
    });
    ff.stderr.on("data", d => {
      if (aborted) return;
      parseProgress(d);
      if (DEBUG) process.stderr.write("[ffmpeg] " + d);
    });

    ff.on("close", code => {
      req?.off("close", onClientClose);
      if (!res.writableEnded) res.end();
      if (aborted) return;
      if (code === 0 && chunks.length > 0) { if (onTranscodeProgress) onTranscodeProgress(100); resolve(Buffer.concat(chunks)); }
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
      if (err.code !== "EPIPE" && err.code !== "EOF") {}
    });

    try {
      const segStream = await fetchStream(segUrl);
      const total = parseInt(segStream.headers?.["content-length"] || "0", 10);
      let received = 0;
      segStream.on("data", chunk => {
        received += chunk.length;
        if (onDownloadProgress) onDownloadProgress(total > 0 ? Math.min(100, (received / total) * 100) : 0);
      });
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

function runFfmpegStream(ffArgs, inputBuf, res, req) {
  return new Promise((resolve, reject) => {
    const ff     = spawn("ffmpeg", ffArgs);
    const chunks = [];
    let   aborted = false;

    const onClientClose = () => {
      if (aborted) return;
      aborted = true;
      dlog("[proxy] client disconnected — killing ffmpeg");
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
    catch (e) {  }
  });
}

function runFfmpeg(ffArgs, inputBuf, onProgress, duration) {
  return new Promise((resolve, reject) => {
    const ff     = spawn("ffmpeg", ffArgs);
    const chunks = [];
    const parseProgress = makeProgressParser(duration, onProgress);

    ff.stdout.on("data", c => chunks.push(c));
    ff.stderr.on("data", d => {
      parseProgress(d);
      if (DEBUG) process.stderr.write("[ffmpeg] " + d);
    });

    ff.on("close", code => {
      if (code === 0 && chunks.length > 0) { if (onProgress) onProgress(100); resolve(Buffer.concat(chunks)); }
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
    catch (e) {  }
  });
}

async function prewarmTranscode(m3u8Url, boardId) {
  const cached = webmCache.get(m3u8Url);
  if (cached && (Date.now() - cached.ts) < WEBM_CACHE_TTL_MS) {
    dlog(`[proxy] prewarm: webm cache already warm`);
    board.finish(boardId, true);
    return;
  }
  if (inFlight.has(m3u8Url)) {
    dlog(`[proxy] prewarm: transcode already in-flight`);
    return;
  }

  dlog(`[proxy] 🔥 prewarm: starting background transcode`);
  board.update(boardId, { status: "downloading" });

  const transcodePromise = (async () => {
    try {
      const { segs, duration } = await resolveFirstSegments(m3u8Url, 1);
      if (segs.length === 0) throw new Error("No segments");

      const tsBuf = await fetchBufWithProgress(segs[0], {
        "Referer": "https://music.apple.com/",
        "Origin" : "https://music.apple.com",
      }, pct => board.update(boardId, { downloadPct: pct }));

      board.update(boardId, { status: "transcoding" });
      const gpu   = gpuDecoder || null;
      const webm  = await runFfmpeg(
        buildFfmpegArgs(gpu, selectedResolution?.height ?? null),
        tsBuf,
        pct => board.update(boardId, { transcodePct: pct }),
        duration
      );
      webmCacheSet(m3u8Url, webm);
      dlog(`[proxy] 🔥 prewarm: done (${(webm.length / 1024).toFixed(0)} KB cached)`);
      board.finish(boardId, true);
      return webm;
    } catch (e) {
      dwarn(`[proxy] prewarm failed: ${e.message}`);
      board.finish(boardId, false, e.message.slice(0, 60));
      throw e;
    }
  })();

  inFlight.set(m3u8Url, transcodePromise);
  transcodePromise.finally(() => inFlight.delete(m3u8Url));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = new URL(req.url, `http://localhost:${PORT}`);

  if (parsed.pathname === "/extension-hash") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hash: currentExtensionHash || null }));
    return;
  }

  if (parsed.pathname === "/write-extension" && req.method === "POST") {
    let bodyBuf;
    try {
      bodyBuf = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end",  () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    } catch (e) {
      res.writeHead(400); res.end("Body read error: " + e.message); return;
    }

    const newCode = bodyBuf.toString("utf8");
    if (!newCode || newCode.length < 100) {
      res.writeHead(400); res.end("Invalid extension code"); return;
    }

    const extPath = path.join(SCRIPT_DIR, EXT_FILENAME);
    try {
      fs.writeFileSync(extPath, newCode, "utf8");
      currentExtensionHash = djb2(newCode);
      console.log(`[update] ${EXT_FILENAME} updated via /write-extension (hash: ${currentExtensionHash})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, hash: currentExtensionHash }));
    } catch (e) {
      console.error(`[update] failed to write ${EXT_FILENAME}: ${e.message}`);
      res.writeHead(500); res.end("Write error: " + e.message);
    }
    return;
  }

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

  if (parsed.pathname === "/artwork") {
    const artist = parsed.searchParams.get("artist") || "";
    const album  = parsed.searchParams.get("album")  || "";
    const title  = parsed.searchParams.get("title")  || "";

    if (!artist && !title) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing artist or title" }));
      return;
    }

    const boardId = board.add(artist, title, album);

    try {
      const { m3u8, source } = await resolveM3u8(artist, album, title, boardId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ m3u8: m3u8 || null, source: source || null }));

      if (m3u8) {
        m3u8ToTrack.set(m3u8, boardId);
        setTimeout(() => prewarmTranscode(m3u8, boardId).catch(() => {}), 800);
      } else {
        board.finish(boardId, false, "artwork not found");
      }
    } catch (e) {
      board.pause();
      console.error("[proxy] /artwork error:", e.message);
      board.finish(boardId, false, e.message.slice(0, 60));
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (parsed.pathname === "/transcode") {
    const m3u8Url = parsed.searchParams.get("url");
    if (!m3u8Url || m3u8Url === "null" || m3u8Url === "undefined") {
      res.writeHead(400); res.end("Missing or invalid ?url="); return;
    }
    try { new URL(m3u8Url); } catch (_) {
      res.writeHead(400); res.end(`Invalid URL: ${m3u8Url.slice(0, 80)}`); return;
    }

    const boardId = m3u8ToTrack.get(m3u8Url);

    try {

      const cached = webmCache.get(m3u8Url);
      if (cached && (Date.now() - cached.ts) < WEBM_CACHE_TTL_MS) {
        cached.hitCount++;
        if (cached.hitCount === 1)
          dlog(`[proxy] ✓ webm cache hit (${(cached.webm.length / 1024).toFixed(0)} KB)`);
        board.finish(boardId, true);
        res.writeHead(200, {
          "Content-Type"  : "video/webm",
          "Content-Length": cached.webm.length,
          "Cache-Control" : "no-store",
          "X-Cache"       : "HIT",
        });
        res.end(cached.webm);
        return;
      }

      if (inFlight.has(m3u8Url)) {
        dlog(`[proxy] ⏳ prewarm in-flight — joining and streaming result`);
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

      dlog(`[proxy] ❄ cold transcode (pipe): ${m3u8Url.slice(0, 80)}...`);
      const t0 = Date.now();
      board.update(boardId, { status: "downloading" });

      let segs, duration;
      for (let attempt = 1; attempt <= 6; attempt++) {
        try { ({ segs, duration } = await resolveFirstSegments(m3u8Url, 1)); break; }
        catch (e) {
          const retryable = e.message.includes("ECONNRESET") || e.message.includes("Timeout") ||
                            e.message.includes("ECONNREFUSED");
          if (!retryable || attempt === 6) throw e;
          dwarn(`[proxy] playlist retry ${attempt}/5 (${e.message.slice(0, 50)})`);
          await new Promise(r => setTimeout(r, 80 + attempt * 40));
        }
      }
      if (!segs || segs.length === 0) throw new Error("No segments found in playlist");

      dlog(`[proxy] playlist resolve: ${Date.now() - t0}ms — piping segment directly to ffmpeg`);

      const gpu   = gpuDecoder || null;
      const ffArgs = buildFfmpegArgs(gpu, selectedResolution?.height ?? null);

      const transcodePromise = runFfmpegPipeSegment(
        segs[0], ffArgs, res, req, duration,
        pct => board.update(boardId, { downloadPct: pct, status: "downloading" }),
        pct => board.update(boardId, { transcodePct: pct, status: "transcoding" })
      ).then(webm => {
        dlog(`[proxy] ✓ cold transcode done: ${(webm.length / 1024).toFixed(0)} KB (${Date.now() - t0}ms total)`);
        webmCacheSet(m3u8Url, webm);
        board.finish(boardId, true);
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
      board.pause();
      console.error("[proxy] transcode error:", e.message);
      board.finish(boardId, false, e.message.slice(0, 60));
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Error: ${e.message}`);
      }
    }
    return;
  }

  if (parsed.pathname === "/local-transcode" && req.method === "POST") {
    const ct = req.headers["content-type"] || "";
    let bodyBuf;
    try {
      bodyBuf = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end",  () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    } catch (e) {
      res.writeHead(400); res.end("Body read error: " + e.message); return;
    }

    let fileBuf, mimeType;

    if (ct.includes("multipart/form-data")) {
      const bdMatch = ct.match(/boundary=([^\s;]+)/);
      if (!bdMatch) { res.writeHead(400); res.end("Missing boundary"); return; }
      const parts = parseMultipart(bodyBuf, bdMatch[1]);
      const file  = parts.find(p => p.name === "file" || p.filename);
      if (!file) { res.writeHead(400); res.end("No file part found"); return; }
      fileBuf  = file.data;
      mimeType = file.contentType || "video/mp4";
    } else {

      fileBuf  = bodyBuf;
      mimeType = ct.split(";")[0].trim() || "video/mp4";
    }

    if (!fileBuf || fileBuf.length === 0) { res.writeHead(400); res.end("Empty file"); return; }

    dlog(`[proxy] local-transcode: ${mimeType}, ${(fileBuf.length / 1024).toFixed(0)} KB`);

    const tmpExt  = mimeType.includes("gif") ? ".gif" : mimeType.includes("webm") ? ".webm" : ".mp4";
    const tmpPath = path.join(os.tmpdir(), `animart_${Date.now()}${tmpExt}`);
    dlog(`[proxy] local-transcode: writing temp file → ${tmpPath}`);
    try {
      fs.writeFileSync(tmpPath, fileBuf);
      const stat = fs.statSync(tmpPath);
      dlog(`[proxy] local-transcode: temp file written (${(stat.size / 1024).toFixed(0)} KB)`);
    } catch (e) {
      board.pause();
      console.error(`[proxy] local-transcode: temp file FAILED: ${e.message}`);
      board.render();
      res.writeHead(500); res.end("Temp file write error: " + e.message); return;
    }

    try {
      const gpu    = gpuDecoder || null;
      const height = selectedResolution?.height ?? null;
      const cpuThreads = Math.max(1, os.cpus().length);

      const args = ["-loglevel", "warning", "-y",

        "-fflags", "+genpts+igndts+discardcorrupt",
        "-err_detect", "ignore_err",
      ];

      if (gpu) {
        if      (gpu.hwaccel === "cuda")         args.push("-hwaccel", "cuda");
        else if (gpu.hwaccel === "d3d11va")      args.push("-hwaccel", "d3d11va");
        else if (gpu.hwaccel === "qsv")          args.push("-hwaccel", "qsv");
        else if (gpu.hwaccel === "videotoolbox") args.push("-hwaccel", "videotoolbox");
      }

      args.push("-threads", String(cpuThreads), "-i", tmpPath);

      args.push("-vf", buildScaleFilter(height));

      const crf = !height || height > 720 ? "36" : height >= 720 ? "34" : "33";
      args.push(
        "-c:v",            "libvpx-vp9",
        "-deadline",       "realtime",
        "-cpu-used",       "8",
        "-crf",            crf,
        "-b:v",            "0",
        "-lag-in-frames",  "0",
        "-row-mt",         "1",
        "-tile-columns",   "4",
        "-tile-rows",      "2",
        "-frame-parallel", "1",
        "-error-resilient","1",
        "-threads",        String(cpuThreads),
        "-an", "-f", "webm", "pipe:1"
      );

      const webm = await new Promise((resolve, reject) => {
        const ff     = spawn("ffmpeg", args);
        const chunks = [];
        ff.stdout.on("data", c => chunks.push(c));
        ff.stderr.on("data", d => process.stdout.write("[ffmpeg-local] " + d));
        ff.on("close", code => {
          const buf = Buffer.concat(chunks);
          if (code === 0 && buf.length > 100) resolve(buf);
          else reject(new Error(`ffmpeg exit ${code}, output ${buf.length} bytes — check [ffmpeg-local] logs above`));
        });
        ff.on("error", err => reject(
          err.code === "ENOENT"
            ? new Error("ffmpeg not found in PATH")
            : err
        ));
      });

      dlog(`[proxy] local-transcode: done (${(webm.length / 1024).toFixed(0)} KB WebM)`);
      res.writeHead(200, {
        "Content-Type"  : "video/webm",
        "Content-Length": webm.length,
        "Cache-Control" : "no-store",
      });
      res.end(webm);
    } catch (e) {
      board.pause();
      console.error("[proxy] local-transcode error:", e.message);
      board.render();
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Transcode error: " + e.message);
      }
    } finally {

      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    return;
  }

  if (parsed.pathname === "/cache/clear") {
    const m3u8Count = cache.size, webmCount = webmCache.size;
    cache.clear(); webmCache.clear();
    dlog(`[proxy] cache cleared — m3u8: ${m3u8Count}, webm: ${webmCount} entries`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`Cache cleared (m3u8: ${m3u8Count}, webm: ${webmCount} entries removed)`);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

(async () => {
  loadExtensionHash();
  await runStartupUpdateCheck();
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
    console.log(`   Segments   : 1 (bandwidth-friendly)`);
    console.log(`   Pipe mode  : segment → ffmpeg direct (no buffer wait)`);
    console.log(`   Pre-warm   : ✓ transcode starts immediately after /artwork resolves`);
    console.log(`   Health     : http://localhost:${PORT}/ping`);
    console.log(`   Artwork    : http://localhost:${PORT}/artwork?artist=Drake&title=Nokia`);
    console.log(`   Transcode  : http://localhost:${PORT}/transcode?url=<m3u8_url>`);
    console.log(`   Local xcode: http://localhost:${PORT}/local-transcode  (POST multipart)`);
    console.log(`\n📡 2 APIs searched in parallel (fastest wins):`);
    console.log(`   API-1: artwork.m8tec.top`);
    console.log(`   API-2: iTunes Search + Apple Music scrape`);
    console.log(`\n🗃  WebM Cache: max ${WEBM_CACHE_MAX} tracks, TTL 2h`);
    console.log(`⚡ v3 optimizations: prewarm + direct pipe + MSE streaming`);
    console.log(`💡 Tip: node animart-proxy.js 1080  → switch & save 1080p`);
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
