// ============================================================
//  animated-artwork.mjs  —  Spicetify Extension v2
//  Requires: animart-proxy v2 running at localhost:7799
// ============================================================

(async function AnimatedArtworkV2() {

  while (!Spicetify?.Player?.addEventListener || !Spicetify?.Player?.data) {
    await new Promise(r => setTimeout(r, 200));
  }

  const PROXY_BASE = "http://localhost:7799";

  // ── Auto-Update (silent, tanpa tombol) ────────────────────
  // Fetch versi terbaru dari GitHub, bandingkan dengan kode yang sedang berjalan.
  // Jika ada perbedaan: simpan file baru ke Spicetify extensions folder via proxy
  // /write-extension, lalu reload extension secara otomatis.
  const GITHUB_RAW_URL = "https://raw.githubusercontent.com/JustHfizz/Artworks-Animation-Spicy-Lyrics/main/animated-artwork.mjs";

  async function checkAndAutoUpdate() {
    try {
      // Ambil kode terbaru dari GitHub (timeout 8 detik)
      const resp = await fetch(GITHUB_RAW_URL, {
        signal: AbortSignal.timeout(8000),
        cache : "no-store",
      });
      if (!resp.ok) return; // GitHub tidak dapat dijangkau, lanjutkan normal

      const remoteCode = await resp.text();
      if (!remoteCode || remoteCode.length < 100) return; // respons tidak valid

      // Ekstrak versi dari baris komentar header (cth: "Spicetify Extension v2.1")
      // Jika tidak ada tag versi, bandingkan panjang + hash sederhana
      const extractVer = code => {
        const m = code.match(/Spicetify Extension\s+v([\d.]+)/i);
        return m ? m[1] : null;
      };
      const remoteVer = extractVer(remoteCode);
      const localVer  = extractVer(document.currentScript?.textContent || "");

      // Hash ringan (djb2) untuk perbandingan konten tanpa crypto API
      const djb2 = str => {
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
        return (h >>> 0).toString(36);
      };

      // Ambil hash dari kode yang sedang berjalan (melalui proxy /self-hash)
      // Proxy menyimpan hash saat startup (lihat animart-proxy.js)
      let needsUpdate = false;
      try {
        const hashResp = await fetch(`${PROXY_BASE}/extension-hash`, {
          signal: AbortSignal.timeout(3000),
        });
        if (hashResp.ok) {
          const { hash: cachedHash } = await hashResp.json();
          const remoteHash = djb2(remoteCode);
          needsUpdate = (cachedHash !== remoteHash);
          if (needsUpdate) {
            L(`Auto-update: hash berubah (${cachedHash} → ${remoteHash})`);
          } else {
            L(`Auto-update: sudah versi terbaru ✓ (hash ${remoteHash})`);
          }
        }
      } catch {
        // Proxy tidak support /extension-hash (versi lama) → fallback ke versi string
        if (remoteVer && localVer) {
          needsUpdate = remoteVer !== localVer;
        }
      }

      if (!needsUpdate) return;

      L(`Auto-update: mengirim file baru ke proxy untuk disimpan...`);

      // Kirim kode baru ke proxy → proxy simpan ke disk & catat hash baru
      const writeResp = await fetch(`${PROXY_BASE}/write-extension`, {
        method : "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body   : remoteCode,
        signal : AbortSignal.timeout(10000),
      });

      if (!writeResp.ok) {
        E(`Auto-update: proxy gagal menyimpan file (${writeResp.status})`);
        return;
      }

      L(`Auto-update: file berhasil diperbarui ✓ — mereload extension...`);

      // Spicetify tidak punya API reload extension per-file,
      // jadi kita inject ulang kode baru langsung ke dalam halaman
      const script = document.createElement("script");
      script.type  = "module";
      script.text  = remoteCode;
      document.head.appendChild(script);
      // Script lama tetap berjalan hingga tab ditutup,
      // tapi instance baru akan meng-override handler Spicetify

    } catch (e) {
      // Jangan crash extension karena gagal update
      E(`Auto-update: ${e.message}`);
    }
  }

  // Jalankan pengecekan update ~3 detik setelah ekstensi ready
  // (delay agar tidak mengganggu startup awal)
  setTimeout(() => checkAndAutoUpdate(), 3000);
  const TAG        = "[AnimArt]";
  const L          = (...a) => console.log(`%c${TAG}`, "color:#1DB954;font-weight:bold", ...a);
  const E          = (...a) => console.error(`%c${TAG}`, "color:#f55;font-weight:bold", ...a);

  async function isProxyAlive() {
    try {
      const r = await fetch(`${PROXY_BASE}/ping`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  }

  // ── SharedVideo ────────────────────────────────────────────
  // One video element per track. Transcoding happens only once.
  // Multiple CanvasMirrors simply copy frames from here.
  class SharedVideo {
    constructor() {
      this.video        = null;
      this.blobUrl      = null;
      this.m3u8Url      = null;
      this.ready        = false;
      this.isLoading    = false;
      this._loadPromise = null;
      this._ac          = null;   // AbortController to cancel in-progress /transcode fetch
    }

    destroy() {
      // cancel in-progress /transcode fetch (if any)
      if (this._ac) { this._ac.abort(); this._ac = null; }
      this.ready     = false;
      this.isLoading = false;
      this._loadPromise = null;
      this.m3u8Url   = null;
      if (this.video) {
        this.video.pause();
        this.video.src = "";
        this.video.load();
        this.video.remove();
        this.video = null;
      }
      if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
    }

    // Fetch WebM from proxy (transcode once), store as blob
    async load(m3u8Url) {
      // If already loaded for the same URL, return immediately
      if (this.ready && this.m3u8Url === m3u8Url) return true;
      // If already loading the same URL, wait for it
      if (this.isLoading && this.m3u8Url === m3u8Url && this._loadPromise) {
        return this._loadPromise;
      }

      this.destroy();
      this.m3u8Url  = m3u8Url;
      this.isLoading = true;
      this._ac       = new AbortController();
      const signal   = this._ac.signal;

      this._loadPromise = (async () => {
        try {
          L(`SharedVideo: transcode start`);
          const resp = await fetch(`${PROXY_BASE}/transcode?url=${encodeURIComponent(m3u8Url)}`, { signal });
          if (!resp.ok) {
            E(`SharedVideo: proxy error ${resp.status}:`, await resp.text().catch(() => ""));
            return false;
          }

          const reader = resp.body.getReader();
          const chunks = [];
          let totalBytes = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalBytes += value.byteLength;
          }
          const webmBuf = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) { webmBuf.set(chunk, offset); offset += chunk.byteLength; }
          L(`SharedVideo: WebM received (${(totalBytes / 1024).toFixed(0)} KB)`);

          const blob     = new Blob([webmBuf], { type: "video/webm" });
          this.blobUrl   = URL.createObjectURL(blob);

          document.getElementById("animart-shared-video")?.remove();
          const video         = document.createElement("video");
          video.id            = "animart-shared-video";
          video.muted         = true;
          video.loop          = true;
          video.playsInline   = true;
          video.autoplay      = true;
          video.preload       = "auto";
          video.playbackRate  = 1.0;
          video.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;";
          document.body.appendChild(video);
          this.video = video;
          video.src  = this.blobUrl;

          await new Promise((resolve, reject) => {
            video.oncanplay = resolve;
            video.onerror   = () => reject(new Error(`video error: ${video.error?.message || "?"}`));
            setTimeout(() => reject(new Error("timeout canplay")), 8000);
          });

          video.play().catch(e => E(`SharedVideo: play error:`, e.message));
          this.ready     = true;
          this.isLoading = false;
          L(`SharedVideo: ready ✓`);
          return true;
        } catch (e) {
          if (e.name === "AbortError") {
            L(`SharedVideo: fetch cancelled (track changed)`);
          } else {
            E(`SharedVideo: load failed:`, e.message);
          }
          this.isLoading = false;
          this.ready     = false;
          return false;
        }
      })();

      return this._loadPromise;
    }
  }

  // ── CanvasMirror ───────────────────────────────────────────
  // Renders frames from SharedVideo onto a canvas in a given container.
  // Does no transcoding at all.
  // Supports pause() / resume() so the draw loop only runs when visible.
  class CanvasMirror {
    constructor(id, sharedVideo) {
      this.id          = id;
      this.sv          = sharedVideo;
      this.canvas      = null;
      this.ctx         = null;
      this.raf         = null;
      this._rvfcId     = null;
      this._stopMirror = null;
      this.running     = false;   // draw loop active
      this.isPlaying   = false;   // mounted and ready
      this.isPaused    = false;   // temporarily suspended (not visible)
      this.isInjecting = false;
      this._cachedW    = 0;       // cache video dimensions to skip resize every frame
      this._cachedH    = 0;
    }

    destroy() {
      this.running     = false;
      this.isPlaying   = false;
      this.isPaused    = false;
      this.isInjecting = false;
      this._cachedW    = 0;
      this._cachedH    = 0;

      if (this._stopMirror) { this._stopMirror(); this._stopMirror = null; }
      if (this.raf)         { cancelAnimationFrame(this.raf); this.raf = null; }
      if (this._rvfcId && this.sv.video) {
        try { this.sv.video.cancelVideoFrameCallback(this._rvfcId); } catch (_) {}
        this._rvfcId = null;
      }
      document.getElementById(`${this.id}-canvas`)?.remove();
      this.canvas = null;
      this.ctx    = null;
    }

    isActive() {
      if (!this.isPlaying) return false;
      const canvas = document.getElementById(`${this.id}-canvas`);
      return !!canvas && document.body.contains(canvas);
    }

    // Pause draw loop temporarily (canvas stays, last frame remains visible)
    pause() {
      if (!this.isPlaying || this.isPaused) return;
      this.isPaused = true;
      this.running  = false;
      if (this._stopMirror) { this._stopMirror(); this._stopMirror = null; }
      if (this.raf)         { cancelAnimationFrame(this.raf); this.raf = null; }
      if (this._rvfcId && this.sv.video) {
        try { this.sv.video.cancelVideoFrameCallback(this._rvfcId); } catch (_) {}
        this._rvfcId = null;
      }
      L(`${this.id}: draw loop paused (off-screen)`);
    }

    // Resume the draw loop
    resume() {
      if (!this.isPlaying || !this.isPaused) return;
      if (!this.sv.ready || !this.sv.video || !this.canvas) return;
      this.isPaused = false;
      this._startMirror();
      L(`${this.id}: draw loop resumed (on-screen)`);
    }

    _mount(container) {
      document.getElementById(`${this.id}-canvas`)?.remove();

      const canvas           = document.createElement("canvas");
      canvas.id              = `${this.id}-canvas`;
      canvas.dataset.animart = "1";
      // will-change:transform → browser promotes to GPU compositing layer
      // desynchronized context → draw off main thread, eliminates jank
      // opacity set to 1 immediately, no fade-in delay
      // FIX 3: contain:strict → isolates canvas from parent layout reflow (lyric scroll, etc.)
      canvas.style.cssText   = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;z-index:10;pointer-events:none;opacity:1;will-change:transform;contain:strict;transform:translateZ(0);backface-visibility:hidden;";
      container.style.position = "relative";
      container.style.overflow = "hidden";
      container.appendChild(canvas);

      this.canvas = canvas;
      // desynchronized: true → canvas draw doesn't wait for vsync on main thread
      this.ctx    = canvas.getContext("2d", { alpha: false, willReadFrequently: false, desynchronized: true });
    }

    _startMirror() {
      this.running  = true;
      this._cachedW = 0;
      this._cachedH = 0;
      const v = this.sv.video;

      // FIX 4: rVFC only for large canvas (fullscreen). Small canvas (Now Bar) uses rAF+throttle.
      // rVFC on small canvas runs at 60fps unthrottled → wastes CPU.
      const isSmallCanvas = (this.canvas?.clientWidth || this.canvas?.width || 9999) < 200;
      if (typeof v.requestVideoFrameCallback === "function" && !isSmallCanvas) {
        const onFrame = () => {
          if (!this.running) return;
          const { videoWidth: w, videoHeight: h } = v;
          if (w === 0 || h === 0) { this._rvfcId = v.requestVideoFrameCallback(onFrame); return; }
          // only resize canvas if video dimensions actually changed
          if (w !== this._cachedW || h !== this._cachedH) {
            this.canvas.width  = w;
            this.canvas.height = h;
            this._cachedW = w;
            this._cachedH = h;
          }
          try { this.ctx.drawImage(v, 0, 0, w, h); } catch (_) { return; }
          if (this.canvas.style.opacity !== "1") {
            this.canvas.style.opacity = "1";
            L(`${this.id}: ✓ visible (${w}×${h})`);
          }
          this._rvfcId = v.requestVideoFrameCallback(onFrame);
        };
        this._rvfcId     = v.requestVideoFrameCallback(onFrame);
        this._stopMirror = () => {
          if (this._rvfcId) { v.cancelVideoFrameCallback(this._rvfcId); this._rvfcId = null; }
        };
        return;
      }

      // rAF fallback
      let _lastTime  = -1;
      let _frameSkip = 0;
      // FIX 2: Now Bar small canvas → throttle to ~20fps (skip 1 of every 2 frames)
      // Fullscreen large canvas → run all frames (skip 0)
      const _getThrottle = () => {
        const w = this.canvas?.clientWidth || this.canvas?.width || 9999;
        return w < 200 ? 1 : 0;  // Now Bar is typically < 80px
      };
      const draw = () => {
        if (!this.running) return;
        this.raf = requestAnimationFrame(draw);
        if (document.visibilityState === "hidden") return;
        if (!v || v.readyState < 2 || v.paused || v.ended || v.videoWidth === 0) return;
        // skip frames for small canvas (Now Bar)
        if (_frameSkip > 0) { _frameSkip--; return; }
        _frameSkip = _getThrottle();
        // skip if frame hasn't changed yet
        if (v.currentTime === _lastTime) return;
        _lastTime = v.currentTime;
        const { videoWidth: w, videoHeight: h } = v;
        // only resize canvas if video dimensions actually changed
        if (w !== this._cachedW || h !== this._cachedH) {
          this.canvas.width  = w;
          this.canvas.height = h;
          this._cachedW = w;
          this._cachedH = h;
        }
        try { this.ctx.drawImage(v, 0, 0, w, h); } catch (_) { return; }
        if (this.canvas.style.opacity !== "1") {
          this.canvas.style.opacity = "1";
          L(`${this.id}: ✓ visible (${w}×${h})`);
        }
      };
      this.raf         = requestAnimationFrame(draw);
      this._stopMirror = () => { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; } };
    }

    // Inject canvas into container and mirror from a ready SharedVideo
    async show(container) {
      this.destroy();
      this._mount(container);
      this.isInjecting = true;

      if (!this.sv.ready || !this.sv.video) {
        E(`${this.id}: SharedVideo not ready`);
        this.isInjecting = false;
        return false;
      }

      try {
        this._startMirror();
        this.isPlaying   = true;
        this.isInjecting = false;
        L(`${this.id}: mirror started (no transcode) ✓`);
        return true;
      } catch (e) {
        E(`${this.id}: show failed:`, e.message);
        this.destroy();
        return false;
      }
    }
  }

  // ── MirrorManager ──────────────────────────────────────────
  // Ensures only ONE draw loop is active at a time.
  // Mirrors that are not visible are paused, not destroyed.
  const MirrorManager = {
    _mirrors: [],

    register(...mirrors) {
      this._mirrors = mirrors;
    },

    // Detect which canvas is currently visible in the viewport
    // Avoids getBoundingClientRect() to prevent triggering layout reflow
    _isVisible(mirror) {
      const canvas = mirror.canvas;
      if (!canvas || !document.body.contains(canvas)) return false;
      // checkVisibility is cheaper than getBoundingClientRect (no forced reflow)
      if (typeof canvas.checkVisibility === "function") {
        return canvas.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
      }
      // fallback: use offsetParent — false if display:none
      return canvas.offsetParent !== null || canvas.style.position === "fixed";
    },

    update() {
      for (const m of this._mirrors) {
        if (!m.isPlaying) continue;
        const visible = this._isVisible(m);
        if (visible && m.isPaused)   { m.resume(); }
        if (!visible && !m.isPaused) { m.pause();  }
      }
    },
  };

  // ── LocalArtwork ───────────────────────────────────────────
  // Stores local artwork per track URI (MP4/GIF/image from user).
  // If a local override exists → SharedVideo uses the local blobUrl, not the proxy.
  // If reset → SharedVideo falls back to the API cache (lastM3u8).
  // All data stored in a Map (in-memory, persists across track changes).
  const LocalArtwork = {
    // Map<uri, { blobUrl, type }>
    _store: new Map(),

    set(uri, file) {
      // Revoke old blobUrl if present
      const old = this._store.get(uri);
      if (old) URL.revokeObjectURL(old.blobUrl);
      const blobUrl = URL.createObjectURL(file);
      this._store.set(uri, { blobUrl, type: file.type, name: file.name });
      L(`LocalArtwork: set for ${uri} (${file.name})`);
      return blobUrl;
    },

    get(uri) { return this._store.get(uri) || null; },

    remove(uri) {
      const entry = this._store.get(uri);
      if (entry) { URL.revokeObjectURL(entry.blobUrl); this._store.delete(uri); }
      L(`LocalArtwork: removed for ${uri}`);
    },

    has(uri) { return this._store.has(uri); },
  };

  // ── SharedVideoLocal ───────────────────────────────────────
  // Like SharedVideo but sourced from a local blobUrl (MP4/GIF/image).
  // Reuses the same class structure so CanvasMirror needs no changes.
  class SharedVideoLocal {
    constructor() {
      this.video   = null;
      this.blobUrl = null;
      this.ready   = false;
    }

    destroy() {
      this.ready = false;
      if (this.video) {
        this.video.pause();
        this.video.src = "";
        this.video.load();
        this.video.remove();
        this.video = null;
      }
      // Don't revoke blobUrl here — it's managed by LocalArtwork._store
      this.blobUrl = null;
    }

    async load(blobUrl, mimeType) {
      this.destroy();
      this.blobUrl = blobUrl;

      // ── Determine whether transcoding is needed ──────────────────────
      // WebM: plays directly. MP4/GIF/other: transcode to WebM first via proxy.
      const needsTranscode = mimeType !== "video/webm";
      let   playUrl = blobUrl;

      if (needsTranscode) {
        L(`SharedVideoLocal: transcode ${mimeType} → WebM via proxy`);
        try {
          // Fetch blob as ArrayBuffer, send to /local-transcode as raw binary
          // (raw binary is more reliable than multipart — no encoding overhead that could corrupt)
          const rawBuf = await fetch(blobUrl).then(r => r.arrayBuffer());
          const resp = await fetch(`${PROXY_BASE}/local-transcode`, {
            method: "POST",
            headers: { "Content-Type": mimeType },
            body: rawBuf,
            signal: AbortSignal.timeout(120000), // 2 minutes timeout for large files
          });
          if (!resp.ok) {
            const errText = await resp.text().catch(() => "");
            E(`SharedVideoLocal: proxy transcode error ${resp.status}: ${errText}`);
            return false;
          }
          const webmBuf = await resp.arrayBuffer();
          const webmBlob = new Blob([webmBuf], { type: "video/webm" });
          playUrl = URL.createObjectURL(webmBlob);
          L(`SharedVideoLocal: transcoded (${(webmBuf.byteLength / 1024).toFixed(0)} KB WebM)`);
        } catch (e) {
          E(`SharedVideoLocal: transcode failed: ${e.message}`);
          return false;
        }
      }

      document.getElementById("animart-local-video")?.remove();
      const video        = document.createElement("video");
      video.id           = "animart-local-video";
      video.muted        = true;
      video.loop         = true;
      video.playsInline  = true;
      video.autoplay     = true;
      video.preload      = "auto";
      video.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;";
      document.body.appendChild(video);
      this.video = video;
      video.src  = playUrl;

      try {
        await new Promise((resolve, reject) => {
          video.oncanplay = resolve;
          video.onerror   = () => reject(new Error(`local video error: ${video.error?.message || "?"}`));
          setTimeout(() => reject(new Error("timeout canplay local")), 8000);
        });
        video.play().catch(e => E(`SharedVideoLocal: play error:`, e.message));
        this.ready = true;
        L(`SharedVideoLocal: ready ✓ (${mimeType})`);
        return true;
      } catch (e) {
        E(`SharedVideoLocal: load failed:`, e.message);
        this.destroy();
        return false;
      }
    }
  }

  // ── LocalUI ────────────────────────────────────────────────
  const LocalUI = {
    _btn:  null,
    _open: false,
    _showPanel: null,
    _hidePanel: null,

    _iconSVG(size = 20) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M50 8C27 8 8 27 8 50C8 63 14 74 24 81C24 81 28 75 36 75C44 75 44 83 50 83C68 83 83 67 83 50C83 27 73 8 50 8Z" stroke="currentColor" stroke-width="6" fill="currentColor" fill-opacity="0.15" stroke-linejoin="round"/>
        <circle cx="31" cy="36" r="7" fill="currentColor"/>
        <circle cx="52" cy="26" r="7" fill="currentColor"/>
        <circle cx="68" cy="39" r="7" fill="currentColor"/>
        <circle cx="30" cy="57" r="7" fill="currentColor"/>
        <circle cx="50" cy="53" r="8.5" fill="none" stroke="currentColor" stroke-width="5.5"/>
        <line x1="74" y1="27" x2="91" y2="9" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/>
        <path d="M66 20C70 14 82 9 90 11C88 20 81 28 74 27Z" fill="currentColor" opacity="0.9"/>
      </svg>`;
    },

    _findMarketplaceBtn() {
      // Search using various possible selectors
      const sels = [
        "[data-testid='marketplace-button']",
        "[aria-label='Marketplace']","[aria-label='marketplace']",
        "[title='Marketplace']","[title='marketplace']",
        "button[class*='marketplace']","button[class*='Marketplace']",
      ];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      // Heuristic: rightmost button in the same bar as the animart button
      const btn = document.getElementById("animart-local-btn");
      if (btn) {
        const siblings = [...btn.parentElement.querySelectorAll("button")].filter(b => b !== btn);
        return siblings[siblings.length - 1] || null;
      }
      // Fallback: icon-type buttons in the top bar
      for (const barSel of [".main-topBar-container","[data-testid='top-bar']",".Root__top-bar","[class*='topBar']"]) {
        const bar = document.querySelector(barSel);
        if (!bar) continue;
        const btns = [...bar.querySelectorAll("button")].filter(b => b.querySelector("svg") && b.offsetParent);
        if (btns.length) return btns[btns.length - 1];
      }
      return null;
    },

    _cloneStyleFrom(srcEl) {
      // Copy all visual computed styles from srcEl to a new element
      if (!srcEl) return {};
      const cs = window.getComputedStyle(srcEl);
      return {
        width:        cs.width,
        height:       cs.height,
        minWidth:     cs.minWidth || cs.width,
        borderRadius: cs.borderRadius,
        background:   cs.background || cs.backgroundColor,
        border:       cs.border,
        boxShadow:    cs.boxShadow,
        padding:      cs.padding,
        color:        cs.color,
        backdropFilter: cs.backdropFilter || "",
        WebkitBackdropFilter: cs.webkitBackdropFilter || "",
      };
    },

    _getOrCreateBtn() {
      const existing = document.getElementById("animart-local-btn");
      if (existing && document.body.contains(existing)) {
        this._btn = existing;
        return existing;
      }

      const mktBtn = this._findMarketplaceBtn();
      if (!mktBtn) { L("LocalUI: ref button not found yet"); return null; }

      const s   = this._cloneStyleFrom(mktBtn);
      const btn = document.createElement("button");
      btn.id    = "animart-local-btn";
      btn.title = "Local Artwork";
      btn.innerHTML = this._iconSVG(20);

      // Mirror exact computed dimensions from reference button, then apply Liquify glass style
      Object.assign(btn.style, {
        display:             "inline-flex",
        alignItems:          "center",
        justifyContent:      "center",
        width:               s.width,
        height:              s.height,
        minWidth:            s.minWidth,
        // Liquify uses heavily rounded corners — override to match its pill/circle buttons
        borderRadius:        "50%",
        // Glass background matching Liquify's frosted glass aesthetic
        background:          "rgba(255,255,255,0.07)",
        border:              "1px solid rgba(255,255,255,0.12)",
        boxShadow:           "none",
        padding:             s.padding,
        color:               s.color,
        backdropFilter:      "blur(8px)",
        WebkitBackdropFilter:"blur(8px)",
        margin:              "0 2px",
        cursor:              "pointer",
        flexShrink:          "0",
        transition:          "background 0.18s ease, border-color 0.18s ease, transform 0.12s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.18s ease, color 0.15s",
        WebkitAppRegion:     "no-drag",
        boxSizing:           "border-box",
      });

      btn.addEventListener("mouseenter", () => {
        if (!btn._active) {
          btn.style.background   = "rgba(255,255,255,0.14)";
          btn.style.borderColor  = "rgba(255,255,255,0.22)";
        }
        btn.style.transform = "scale(1.08)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.transform = "scale(1)";
        if (!btn._active) {
          btn.style.background  = "rgba(255,255,255,0.07)";
          btn.style.borderColor = "rgba(255,255,255,0.12)";
        }
      });

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        // Click pulse animation
        btn.style.transform = "scale(0.88)";
        btn.style.transition = "transform 0.08s cubic-bezier(0.2,0,0.4,1)";
        setTimeout(() => {
          btn.style.transform = "scale(1)";
          btn.style.transition = "transform 0.18s cubic-bezier(0.34,1.56,0.64,1)";
        }, 80);
      });
      btn.addEventListener("click",     (e) => { e.preventDefault(); e.stopImmediatePropagation(); this.toggle(); });

      // Insert AFTER the marketplace button
      mktBtn.insertAdjacentElement("afterend", btn);
      this._btn = btn;
      L("LocalUI: button mounted ✓");
      return btn;
    },

    // Read theme colors — prioritize reading Liquify's OWN rendered popup/menu
    // (most accurate: mirrors exactly what the installed theme draws), then
    // fall back to Spicetify --spice-* variables, then sane glass defaults.
    _getThemeColors() {
      const cssVar = (name, fallback = "") => {
        const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return val || fallback;
      };

      // ── 1) Try to read Liquify's actual popup/context-menu element ──────
      // Liquify renders its glass popups/menus with these classes — reading
      // computed style from a live one gives the EXACT bg/blur/radius/border
      // the theme uses, instead of guessing from CSS variables.
      const liquifyPopupSelectors = [
        ".main-contextMenu-menu",
        "[data-testid='context-menu']",
        "[class*='contextMenu'][class*='menu']",
        ".main-card-card",          // Liquify card popup
        "[class*='popup'][class*='liquify']",
        ".GenericModal__overlay [class*='Modal']",
        ".main-trackCreditsModal-container",
      ];
      let liveEl = null;
      for (const sel of liquifyPopupSelectors) {
        const el = document.querySelector(sel);
        if (el && getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)") { liveEl = el; break; }
      }

      let liveBg = "", liveRadius = "", liveBlur = "", liveBorder = "";
      if (liveEl) {
        const cs = getComputedStyle(liveEl);
        liveBg     = cs.backgroundColor;
        liveRadius = cs.borderRadius;
        liveBlur   = cs.backdropFilter && cs.backdropFilter !== "none" ? cs.backdropFilter : "";
        liveBorder = cs.borderColor && cs.borderWidth !== "0px" ? cs.borderColor : "";
      }

      // ── 2) Spicetify CSS variables (theme-declared) ──────────────────
      const spiceCard    = cssVar("--spice-card");
      const spiceSidebar = cssVar("--spice-sidebar");
      const spiceMain    = cssVar("--spice-main");
      const spiceText    = cssVar("--spice-text");
      const spiceSub     = cssVar("--spice-subtext");
      const spiceRadius  = cssVar("--spice-border-radius") || cssVar("--liquify-border-radius");

      const spiceBg = spiceCard || spiceSidebar || spiceMain;

      // ── 3) Fallback: any visible chrome element ──────────────────────
      let rawBg = "";
      if (!liveBg && !spiceBg) {
        const bgSelectors = [
          ".Root__nav-bar", ".main-navBar-navBar", "[data-testid='nav-bar']",
          ".Root__main-view",
        ];
        for (const sel of bgSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            const c = getComputedStyle(el).backgroundColor;
            if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") { rawBg = c; break; }
          }
        }
      }

      let textC = spiceText || "";
      if (!textC) {
        const textSelectors = [
          ".main-trackInfo-name",
          "[data-testid='context-menu'] li",
          ".main-contextMenu-menuItemButton",
          "h1[class*='Type']",
        ];
        for (const sel of textSelectors) {
          const el = document.querySelector(sel);
          if (el) { textC = getComputedStyle(el).color; break; }
        }
      }
      textC = textC || "#ffffff";

      // ── Build final color values ──────────────────────────────
      const toRgba = (color, alpha) => {
        if (!color) return null;
        const m = color.match(/rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*[\d.]+)?\)/);
        if (m) return `rgba(${Math.round(m[1])},${Math.round(m[2])},${Math.round(m[3])},${alpha})`;
        const hex = color.replace(/^#/, "");
        if (/^[0-9a-fA-F]{3,8}$/.test(hex)) {
          const h = hex.length <= 4 ? hex.split("").map(c => c+c).join("") : hex.slice(0,6);
          const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
          return `rgba(${r},${g},${b},${alpha})`;
        }
        return null;
      };

      // Source priority: live Liquify popup > --spice-card/sidebar/main > generic chrome
      const source = liveBg || spiceBg || rawBg;

      const bg      = toRgba(source, 0.55) || "rgba(24,24,24,0.55)";
      const borderC = toRgba(liveBorder || source, liveBorder ? 0.9 : 0.20) || "rgba(255,255,255,0.13)";
      const btnC    = toRgba(source, 0.10) || "rgba(255,255,255,0.06)";

      const subC = spiceSub
        ? (toRgba(spiceSub, 0.85) || "rgba(255,255,255,0.55)")
        : (toRgba(textC, 0.60)    || "rgba(255,255,255,0.55)");

      // Radius priority: live popup's actual radius > theme variable > Liquify's default ~18px
      const panelRadius = liveRadius || spiceRadius || "18px";
      const blur         = liveBlur || "blur(28px) saturate(180%)";

      L("theme src=" + (source||"none").slice(0,25) + " radius=" + panelRadius + " text=" + textC.slice(0,20));
      return { bg, textC, subC, btnC, borderC, panelRadius, blur };
    },

    _buildPanel() {
      document.getElementById("animart-local-panel")?.remove();

      // Inject panel styles — Liquify glassmorphic theme integration
      // Liquify uses heavy backdrop-blur, large rounded corners (16-20px), and glass-like panels.
      // We mirror its aesthetic: blurred frosted glass card, subtle white borders, smooth transitions.
      if (!document.getElementById("animart-panel-style")) {
        const style = document.createElement("style");
        style.id = "animart-panel-style";
        style.textContent = `
          /* ── Liquify-style glassmorphic panel ─────────────────── */
          /* base look only — bg / radius / blur / border are set inline per-call
             from _getThemeColors() so the panel actually follows the installed theme */
          #animart-local-panel {
            font-family: var(--font-family, var(--encore-body-font-stack, 'CircularSp', 'CircularSp-Arab', 'CircularSp-Hebr', 'CircularSp-Cyrl', 'CircularSp-Grek', 'CircularSp-Deva', 'var(--fallback-fonts)', sans-serif));
            box-shadow:
              0 8px 32px rgba(0,0,0,0.45),
              0 2px 8px rgba(0,0,0,0.25),
              inset 0 1px 0 rgba(255,255,255,0.1);
            animation: animart-panel-in 0.18s cubic-bezier(0.34,1.4,0.64,1) both;
          }
          @keyframes animart-panel-in {
            from { opacity:0; transform: translateY(6px) scale(0.97); }
            to   { opacity:1; transform: translateY(0)   scale(1);    }
          }
          /* Status pill */
          #animart-local-status {
            background: rgba(255,255,255,0.07) !important;
            border: 1px solid rgba(255,255,255,0.09) !important;
            border-radius: calc(var(--animart-radius, 18px) * 0.55) !important;
            color: var(--spice-subtext, rgba(255,255,255,0.55)) !important;
            backdrop-filter: blur(4px) !important;
          }
          /* Upload buttons — glass row */
          .animart-upload-label {
            border: 1px solid rgba(255,255,255,0.11) !important;
            border-radius: calc(var(--animart-radius, 18px) * 0.65) !important;
            color: var(--spice-text, #ffffff) !important;
            background: rgba(255,255,255,0.05) !important;
            transition: background 0.18s ease, border-color 0.18s ease, transform 0.12s ease !important;
          }
          .animart-upload-label:hover {
            background: rgba(255,255,255,0.12) !important;
            border-color: rgba(255,255,255,0.22) !important;
            transform: translateY(-1px) !important;
          }
          .animart-upload-label:active {
            transform: scale(0.97) !important;
          }
          /* Reset button */
          #animart-reset-btn {
            border-radius: calc(var(--animart-radius, 18px) * 0.65) !important;
            transition: background 0.18s ease, transform 0.1s ease !important;
          }
          #animart-reset-btn:not(:disabled):hover {
            transform: translateY(-1px) !important;
          }
          /* Panel title divider */
          #animart-panel-divider {
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent);
            margin: 8px 0;
          }
          /* Liquify-style active button glow ring */
          #animart-local-btn.animart-active {
            box-shadow: 0 0 0 2px var(--spice-button, #1DB954),
                        0 0 12px rgba(var(--spice-rgb-button, 29,185,84), 0.35) !important;
          }
        `;
        document.head.appendChild(style);
      }

      const { bg, textC, subC, btnC, borderC, panelRadius, blur } = this._getThemeColors();

      const panel = document.createElement("div");
      panel.id = "animart-local-panel";
      Object.assign(panel.style, {
        position:       "fixed",
        zIndex:         "99999",
        padding:        "16px 16px 13px",
        width:          "268px",
        userSelect:     "none",
        display:        "none",
        // ── Dynamic theme-matched look (follows the installed Liquify config) ──
        background:           bg,
        color:                textC,
        border:               `1px solid ${borderC}`,
        borderRadius:         panelRadius,
        backdropFilter:       blur,
        WebkitBackdropFilter: blur,
      });
      panel.style.setProperty("--animart-radius", panelRadius);

      const hasLocal = currentUri && LocalArtwork.has(currentUri);

      panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px;">
          <span style="color:var(--spice-button,#1DB954);opacity:0.95;line-height:0;filter:drop-shadow(0 0 5px rgba(29,185,84,0.4));">${this._iconSVG(22)}</span>
          <span style="font-size:12.5px;font-weight:700;color:var(--spice-text,#fff);letter-spacing:0.3px;text-shadow:0 1px 3px rgba(0,0,0,0.3);">Local Artwork</span>
        </div>

        <div id="animart-panel-divider"></div>

        <div id="animart-local-status" style="
          font-size:11px;padding:6px 10px;margin-bottom:10px;
          color:${hasLocal ? "var(--spice-button,#1DB954)" : "var(--spice-subtext,rgba(255,255,255,0.55))"};
          line-height:1.4;
        ">${hasLocal ? "✦ Custom artwork active" : "Fetched via Spotify Canvas API"}</div>

        <label class="animart-upload-label" style="
          display:flex;align-items:center;gap:10px;
          padding:9px 11px;
          cursor:pointer;margin-bottom:6px;font-size:12px;font-weight:500;
        ">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--spice-button,#1DB954)" stroke-width="2.2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          Upload Video (MP4 / WebM)
          <input id="animart-input-mp4" type="file" accept="video/mp4,video/webm,video/*" style="display:none"/>
        </label>

        <label class="animart-upload-label" style="
          display:flex;align-items:center;gap:10px;
          padding:9px 11px;
          cursor:pointer;margin-bottom:11px;font-size:12px;font-weight:500;
        ">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--spice-button,#1DB954)" stroke-width="2.2" stroke-linecap="round"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M8 12h3m0 0v-2m0 2v2m3-4v4m2-4h2"/></svg>
          Upload GIF / Image
          <input id="animart-input-gif" type="file" accept="image/gif,image/png,image/jpeg,image/jpg,image/webp,image/avif,image/*" style="display:none"/>
        </label>

        <button id="animart-reset-btn" style="
          width:100%;padding:8px;border:none;cursor:${hasLocal?"pointer":"not-allowed"};
          background:rgba(255,75,75,0.12);
          border: 1px solid rgba(255,100,100,0.18);
          color:var(--spice-notification-error,#ff6b6b);
          font-size:11.5px;font-weight:600;letter-spacing:0.2px;
          opacity:${hasLocal?"1":"0.38"};
          font-family:inherit;
        " ${hasLocal?"":"disabled"}
          onmouseenter="if(!this.disabled){this.style.background='rgba(255,75,75,0.22)';this.style.borderColor='rgba(255,100,100,0.32)';}"
          onmouseleave="this.style.background='rgba(255,75,75,0.12)';this.style.borderColor='rgba(255,100,100,0.18)'"
          >
          ↺ &nbsp;Reset to API Artwork
        </button>`;

      document.body.appendChild(panel);

      // Events file input
      const handleFile = async (file) => {
        if (!file || !currentUri) return;
        L(`LocalUI: file: ${file.name} (${file.type})`);
        const isWebm = file.type === "video/webm";
        this._setStatus(isWebm ? "⏳ Loading WebM..." : "⏳ Transcoding via proxy...", "#f0c040");
        await applyLocalArtwork(currentUri, file);
        this._updatePanel();
        this.close();
      };
      panel.querySelector("#animart-input-mp4").onchange = (e) => { handleFile(e.target.files[0]); e.target.value=""; };
      panel.querySelector("#animart-input-gif").onchange = (e) => { handleFile(e.target.files[0]); e.target.value=""; };
      panel.querySelector("#animart-reset-btn").onclick  = async (e) => {
        e.stopPropagation();
        if (!currentUri) return;
        await resetToApiArtwork(currentUri);
        this._updatePanel();
        this.close();
      };

      return panel;
    },

    _positionPanel(panel) {
      if (!panel || !this._btn) return;
      const r   = this._btn.getBoundingClientRect();
      const pw  = 260;
      const ph  = 230; // estimasi tinggi panel

      // Horizontal: center relative to button
      let left = r.left + r.width / 2 - pw / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));

      // Vertical: try ABOVE button first
      let top  = r.top - ph - 8;
      // If clipped at the top, show BELOW the button
      if (top < 8) top = r.bottom + 8;

      panel.style.left   = left + "px";
      panel.style.top    = top  + "px";
      panel.style.bottom = "";
    },

    _setStatus(text, color) {
      const el = document.getElementById("animart-local-status");
      if (!el) return;
      el.textContent = text;
      if (color) el.style.color = color;
    },

    _updatePanel() {
      const hasLocal = !!(currentUri && LocalArtwork.has(currentUri));
      const { subC }  = this._getThemeColors();
      const accentC = getComputedStyle(document.documentElement).getPropertyValue("--spice-button").trim() || "#1DB954";
      this._setStatus(
        hasLocal ? "✦ Custom artwork active" : "Fetched via Spotify Canvas API",
        hasLocal ? accentC : subC
      );
      const resetBtn = document.getElementById("animart-reset-btn");
      if (resetBtn) {
        resetBtn.disabled      = !hasLocal;
        resetBtn.style.opacity = hasLocal ? "1" : "0.38";
        resetBtn.style.cursor  = hasLocal ? "pointer" : "not-allowed";
      }
      if (this._btn) {
        this._btn._active      = hasLocal;
        if (hasLocal) {
          this._btn.classList.add("animart-active");
          this._btn.style.boxShadow = `0 0 0 2px var(--spice-button, #1DB954)55`;
        } else {
          this._btn.classList.remove("animart-active");
          this._btn.style.boxShadow = "";
        }
      }
    },

    open() {
      const panel = this._buildPanel();
      this._positionPanel(panel);
      panel.style.display = "block";
      this._open = true;
    },

    close() {
      const panel = document.getElementById("animart-local-panel");
      if (panel) panel.style.display = "none";
      this._open = false;
    },

    toggle() {
      if (this._open) {
        this.close();
      } else {
        this.open();
      }
    },

    tryMount() {
      if (document.body.contains(document.getElementById("animart-local-btn"))) return;
      this._btn = null;
      this._getOrCreateBtn();
    },

    initOutsideListener() {
      // Single global listener — detects clicks outside button + panel → close
      document.addEventListener("click", (e) => {
        if (!this._open) return;
        const btn = document.getElementById("animart-local-btn");
        const pnl = document.getElementById("animart-local-panel");
        if (btn && btn.contains(e.target)) return;   // click on button → toggle() handles it
        if (pnl && pnl.contains(e.target)) return;   // click inside panel → allow
        this.close();
      }, false);  // bubbling phase, not capture
    },
  };

  let currentUri  = null;
  let lastM3u8    = null;
  let lastSource  = null;   // "m8tec" | "apple" | "local" | null
  let proxyOk     = false;
  const sharedVideo      = new SharedVideo();
  const sharedVideoLocal = new SharedVideoLocal();
  const playerNPV        = new CanvasMirror("animart-npv", sharedVideo);
  const playerSL         = new CanvasMirror("animart-sl",  sharedVideo);

  MirrorManager.register(playerNPV, playerSL);

  // ── activeSharedVideo: pointer indicating which source CanvasMirror reads from ─
  // Default: sharedVideo (dari API). Jika local → sharedVideoLocal.
  // CanvasMirror.sv must be updated when switching sources.
  function switchToVideo(sv) {
    playerNPV.sv = sv;
    playerSL.sv  = sv;
  }

  // Apply local artwork for the current URI
  async function applyLocalArtwork(uri, file) {
    if (!uri) return;
    // Save to LocalArtwork cache
    const blobUrl = LocalArtwork.set(uri, file);

    // Stop mirror draw loop (don't destroy API sharedVideo — keep cache alive)
    playerNPV.destroy();
    playerSL.destroy();

    // Load into SharedVideoLocal
    const ok = await sharedVideoLocal.load(blobUrl, file.type);
    if (!ok) { E("LocalArtwork: failed to load local video"); return; }

    // Switch mirror to local source
    switchToVideo(sharedVideoLocal);

    tryInject(playerNPV, findNpv, "NPV (local)");
    tryInject(playerSL,  findSL,  "SL  (local)");
    L(`LocalArtwork: active for ${uri}`);
  }

  // Reset to API artwork (from still-alive sharedVideo cache)
  async function resetToApiArtwork(uri) {
    LocalArtwork.remove(uri);

    // Stop mirror lokal
    playerNPV.destroy();
    playerSL.destroy();
    sharedVideoLocal.destroy();

    // Switch back to API source
    switchToVideo(sharedVideo);

    if (!sharedVideo.ready) {
      // sharedVideo was never loaded for this track → reload from lastM3u8
      if (lastM3u8) {
        const loaded = await sharedVideo.load(lastM3u8);
        if (!loaded) { E("Reset: sharedVideo failed to reload"); return; }
      } else {
        L("Reset: no API artwork for this track");
        return;
      }
    }

    tryInject(playerNPV, findNpv, "NPV (reset)");
    tryInject(playerSL,  findSL,  "SL  (reset)");
    L(`LocalArtwork: reset to API for ${uri}`);
  }

  async function fetchM3u8(artist, album, title) {
    const params = new URLSearchParams({ artist: artist || "", album: album || "", title: title || "" });
    try {
      const resp = await fetch(`${PROXY_BASE}/artwork?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) { E(`/artwork error: ${resp.status}`); return null; }
      const json = await resp.json();
      // json.source = "m8tec" | "apple" | null
      return json.m3u8 ? { m3u8: json.m3u8, source: json.source || null } : null;
    } catch (e) { E("fetchM3u8:", e.message); return null; }
  }

  const findNpv = () =>
    document.querySelector(".MediaImageContainer") ||
    document.querySelector("[data-testid='cover-art-image']")?.closest("[data-testid='cover-art']") ||
    document.querySelector("[data-testid='now-playing-widget'] [data-testid='cover-art']") ||
    document.querySelector(".main-coverSlotExpanded-container") || null;

  const findSL = () => {
    const root =
      document.querySelector("#SpicyLyricsPage") ||
      document.querySelector(".spicylyrics-page") ||
      document.querySelector("[class*='SpicyLyrics']") ||
      document.querySelector("[data-spicylyrics]") ||
      document.querySelector(".Root__fullscreen-page [class*='SpicyLyrics']") ||
      document.querySelector(".Root__fullscreen-page #SpicyLyricsPage") ||
      document.querySelector("[class*='fullscreen'] [class*='SpicyLyrics']") ||
      document.querySelector("[class*='fullscreen'] #SpicyLyricsPage");
    if (!root) return null;
    return (
      root.querySelector(".MediaImageContainer") ||
      root.querySelector("[data-testid='cover-art']") ||
      root.querySelector("[data-testid='cover-art-image']")?.closest("[data-testid='cover-art']") ||
      root.querySelector(".cover-art") ||
      root.querySelector("[class*='CoverArt']") ||
      root
    );
  };

  // tryInject: find container, then show mirror canvas (no re-transcoding)
  async function tryInject(player, finder, label, tries = 20) {
    if (player.isInjecting) return false;
    if (player.isActive())  return true;
    player.isInjecting = true;
    try {
      for (let i = 0; i < tries; i++) {
        const el = finder();
        if (el) {
          const ok = await player.show(el);
          if (ok) {
            L(`✓ ${label}`);
            MirrorManager.update();
          }
          return ok;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      L(`⚠ ${label}: container not found`);
    } finally {
      player.isInjecting = false;
    }
    return false;
  }

  async function onSongChange() {
    const track = Spicetify.Player.data?.item;
    if (!track) return;
    const uri = track.uri;
    if (uri === currentUri) return;
    currentUri = uri;

    const artist = track.metadata?.artist_name || "";
    const album  = track.metadata?.album_title  || "";
    const title  = track.metadata?.title        || "";
    L(`▶ "${title}" — ${artist}`);

    // Destroy mirror + kedua shared video lama
    playerNPV.destroy();
    playerSL.destroy();
    sharedVideo.destroy();
    sharedVideoLocal.destroy();
    lastM3u8   = null;
    lastSource = null;

    // Reset mirror pointer to API (default)
    switchToVideo(sharedVideo);

    // Update local UI button (status reset per track)
    LocalUI._updatePanel?.();

    if (!artist && !title) return;

    // ── Check if this track has a local override ──────────────
    const localEntry = LocalArtwork.get(uri);
    if (localEntry) {
      L(`LocalArtwork: found for ${uri} — skip API`);
      lastSource = "local";
      switchToVideo(sharedVideoLocal);
      const ok = await sharedVideoLocal.load(localEntry.blobUrl, localEntry.type);
      if (ok) {
        tryInject(playerNPV, findNpv, "NPV (local)");
        tryInject(playerSL,  findSL,  "SL  (local)");
      }
      // Still fetch m3u8 in the background for future reset
      proxyOk = await isProxyAlive();
      if (proxyOk) {
        fetchM3u8(artist, album, title).then(result => {
          if (result) { lastM3u8 = result.m3u8; L(`LocalArtwork: API m3u8 cached for reset`); }
        });
      }
      return;
    }

    // ── Normal flow: API artwork ───────────────────────────────
    proxyOk = await isProxyAlive();
    if (!proxyOk) { E("Proxy not running! Start with: node animart-proxy.js"); return; }

    const result = await fetchM3u8(artist, album, title);
    if (!result) { L("No animated artwork for this track"); return; }
    lastM3u8   = result.m3u8;
    lastSource = result.source;   // "m8tec" | "apple"

    const loaded = await sharedVideo.load(lastM3u8);
    if (!loaded) { E("SharedVideo failed to load"); return; }

    tryInject(playerNPV, findNpv, "Now Bar");
    tryInject(playerSL,  findSL,  "Spicy Lyrics");
  }

  let observerTimer  = null;
  let lastFullscreen = !!document.fullscreenElement;

  function scheduleReInject(delay = 300) {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      const hasLocal = currentUri && LocalArtwork.has(currentUri);
      const activeSV = hasLocal ? sharedVideoLocal : sharedVideo;
      if (!activeSV.ready) return;
      if (!hasLocal && (!lastM3u8 || !proxyOk)) return;
      if (!playerNPV.isActive() && !playerNPV.isInjecting)
        tryInject(playerNPV, findNpv, "NPV (re)", 8);
      if (!playerSL.isActive() && !playerSL.isInjecting)
        tryInject(playerSL, findSL, "SL (re)", 8);
    }, delay);
  }

  // Mount global outside-click listener ONCE
  LocalUI.initOutsideListener();

  // ── LocalUI mount polling ──────────────────────────────────
  // Spicy Lyrics DOM can appear at any time → try mounting button every 500ms
  // (faster than 2000ms so the button appears promptly when Spicy Lyrics opens)
  setInterval(() => LocalUI.tryMount(), 500);
  // Try a few times immediately at startup
  setTimeout(() => LocalUI.tryMount(), 300);
  setTimeout(() => LocalUI.tryMount(), 1000);
  setTimeout(() => LocalUI.tryMount(), 2500);

  // Native fullscreen API
  document.addEventListener("fullscreenchange", () => {
    const isFs = !!document.fullscreenElement;
    if (isFs !== lastFullscreen) {
      lastFullscreen = isFs;
      L(`Fullscreen ${isFs ? "entered" : "exited"} — re-injecting`);
      playerNPV.destroy();
      playerSL.destroy();
      // shorter delay: new canvas appears immediately without waiting long
      scheduleReInject(150);
    }
  });

  // Spicetify CSS-based fullscreen detection
  const fsObserver = new MutationObserver(() => {
    const isFs =
      document.documentElement.classList.contains("fullscreen") ||
      document.body.classList.contains("fullscreen") ||
      !!document.querySelector(".Root__fullscreen-page") ||
      !!document.querySelector("[class*='fullscreen-mode']");
    if (isFs !== lastFullscreen) {
      lastFullscreen = isFs;
      L(`Spicetify fullscreen ${isFs ? "entered" : "exited"} — re-injecting`);
      playerNPV.destroy();
      playerSL.destroy();
      scheduleReInject(150);
    }
  });
  fsObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  fsObserver.observe(document.body,            { attributes: true, attributeFilter: ["class"] });

  // DOM observer — only watch for removed animart canvases.
  // Debounced: the callback fires at most once per 200ms to avoid
  // hammering the main thread during Spicy Lyrics lyric scrolling.
  let _obsTimer = null;
  const observer = new MutationObserver((mutations) => {
    if (!lastM3u8 || !proxyOk) return;
    const canvasRemoved = mutations.some(m => {
      for (const node of m.removedNodes) {
        if (node.id === "animart-npv-canvas" || node.id === "animart-sl-canvas") return true;
        if (node.querySelector?.("#animart-npv-canvas, #animart-sl-canvas")) return true;
      }
      return false;
    });
    if (!canvasRemoved) return;
    // Debounce re-inject to avoid triggering on every lyric update frame
    clearTimeout(_obsTimer);
    _obsTimer = setTimeout(() => scheduleReInject(100), 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Mount LocalUI on DOM changes (Spicy Lyrics may have just appeared).
  // Use subtree:false + childList only to avoid firing on every lyric node change.
  let _uiTimer = null;
  const uiObserver = new MutationObserver(() => {
    clearTimeout(_uiTimer);
    _uiTimer = setTimeout(() => LocalUI.tryMount(), 300);
  });
  uiObserver.observe(document.body, { childList: true, subtree: false });

  // ── FIX 1: Periodic MirrorManager polling ─────────────────
  // Without this, pause/resume never fires → both draw loops run simultaneously
  setInterval(() => MirrorManager.update(), 800);  // reduced polling frequency to ease main thread

  L("v2 — single transcode + multi-canvas mirror + rVFC + rAF fallback + VP9");
  proxyOk = await isProxyAlive();
  if (proxyOk) L("✓ Proxy running at localhost:7799");
  else { E("Proxy not running!"); E("Start with: node animart-proxy.js"); }

  Spicetify.Player.addEventListener("songchange", onSongChange);
  await onSongChange();
  L("Ready ✓");

})();
