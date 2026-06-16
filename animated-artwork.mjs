// ============================================================
//  animated-artwork.mjs  —  Spicetify Extension v2
//  Requires: animart-proxy v2 running at localhost:7799
// ============================================================

(async function AnimatedArtworkV2() {

  while (!Spicetify?.Player?.addEventListener || !Spicetify?.Player?.data) {
    await new Promise(r => setTimeout(r, 200));
  }

  const PROXY_BASE = "http://localhost:7799";
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
  // Satu video element per lagu. Transcode hanya terjadi sekali.
  // CanvasMirror yang berbeda-beda tinggal copy frame dari sini.
  class SharedVideo {
    constructor() {
      this.video       = null;
      this.blobUrl     = null;
      this.m3u8Url     = null;
      this.ready       = false;
      this.isLoading   = false;
      this._loadPromise = null;
    }

    destroy() {
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

    // Ambil WebM dari proxy (transcode sekali), simpan sebagai blob
    async load(m3u8Url) {
      // Jika sudah ada untuk URL yang sama, langsung return
      if (this.ready && this.m3u8Url === m3u8Url) return true;
      // Jika sedang loading URL yang sama, tunggu
      if (this.isLoading && this.m3u8Url === m3u8Url && this._loadPromise) {
        return this._loadPromise;
      }

      this.destroy();
      this.m3u8Url  = m3u8Url;
      this.isLoading = true;

      this._loadPromise = (async () => {
        try {
          L(`SharedVideo: transcode start`);
          const resp = await fetch(`${PROXY_BASE}/transcode?url=${encodeURIComponent(m3u8Url)}`);
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
          E(`SharedVideo: load failed:`, e.message);
          this.isLoading = false;
          this.ready     = false;
          return false;
        }
      })();

      return this._loadPromise;
    }
  }

  // ── CanvasMirror ───────────────────────────────────────────
  // Menampilkan frame dari SharedVideo ke canvas di container tertentu.
  // Tidak melakukan transcode sama sekali.
  // Mendukung pause() / resume() agar draw loop hanya aktif saat visible.
  class CanvasMirror {
    constructor(id, sharedVideo) {
      this.id          = id;
      this.sv          = sharedVideo;
      this.canvas      = null;
      this.ctx         = null;
      this.raf         = null;
      this._rvfcId     = null;
      this._stopMirror = null;
      this.running     = false;   // draw loop aktif
      this.isPlaying   = false;   // sudah di-mount dan siap
      this.isPaused    = false;   // sementara di-suspend (tidak visible)
      this.isInjecting = false;
    }

    destroy() {
      this.running     = false;
      this.isPlaying   = false;
      this.isPaused    = false;
      this.isInjecting = false;

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

    // Hentikan draw loop sementara (canvas tetap ada, frame terakhir tetap tampil)
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

    // Nyalakan kembali draw loop
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
      canvas.style.cssText   = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;z-index:10;pointer-events:none;opacity:0;transition:opacity 0.3s ease";
      container.style.position = "relative";
      container.style.overflow = "hidden";
      container.appendChild(canvas);

      this.canvas = canvas;
      this.ctx    = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
    }

    _startMirror() {
      this.running = true;
      const v = this.sv.video;

      if (typeof v.requestVideoFrameCallback === "function") {
        const onFrame = () => {
          if (!this.running) return;
          const { videoWidth: w, videoHeight: h } = v;
          if (w === 0 || h === 0) { this._rvfcId = v.requestVideoFrameCallback(onFrame); return; }
          if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w; this.canvas.height = h;
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
      const draw = () => {
        if (!this.running) return;
        this.raf = requestAnimationFrame(draw);
        if (document.visibilityState === "hidden") return;
        if (!v || v.readyState < 2 || v.paused || v.ended || v.videoWidth === 0) return;
        const { videoWidth: w, videoHeight: h } = v;
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w; this.canvas.height = h;
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

    // Inject canvas ke container, mirror dari SharedVideo yang sudah ready
    async show(container) {
      this.destroy();
      this._mount(container);
      this.isInjecting = true;

      if (!this.sv.ready || !this.sv.video) {
        E(`${this.id}: SharedVideo belum ready`);
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
  // Memastikan hanya SATU draw loop aktif di satu waktu.
  // Mirror yang sedang tidak visible di-pause, bukan di-destroy.
  const MirrorManager = {
    _mirrors: [],   // semua CanvasMirror yang terdaftar

    register(...mirrors) {
      this._mirrors = mirrors;
    },

    // Deteksi canvas mana yang sedang visible di viewport
    _isVisible(mirror) {
      const canvas = mirror.canvas;
      if (!canvas || !document.body.contains(canvas)) return false;
      const rect = canvas.getBoundingClientRect();
      // Visible jika ada area yang muncul di viewport
      return (
        rect.width  > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.top    < window.innerHeight &&
        rect.right  > 0 && rect.left   < window.innerWidth
      );
    },

    // Panggil setiap kali mode berganti atau DOM berubah
    // Pause semua yang tidak visible, resume yang visible
    update() {
      for (const m of this._mirrors) {
        if (!m.isPlaying) continue;
        const visible = this._isVisible(m);
        if (visible && m.isPaused)  { m.resume(); }
        if (!visible && !m.isPaused){ m.pause();  }
      }
    },
  };

  let currentUri  = null;
  let lastM3u8    = null;
  let proxyOk     = false;
  const sharedVideo = new SharedVideo();
  const playerNPV   = new CanvasMirror("animart-npv", sharedVideo);
  const playerSL    = new CanvasMirror("animart-sl",  sharedVideo);

  async function fetchM3u8(artist, album, title) {
    const params = new URLSearchParams({ artist: artist || "", album: album || "", title: title || "" });
    try {
      const resp = await fetch(`${PROXY_BASE}/artwork?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) { E(`/artwork error: ${resp.status}`); return null; }
      const json = await resp.json();
      return json.m3u8 || null;
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

  // tryInject: cari container, lalu show mirror canvas (tidak transcode ulang)
  async function tryInject(player, finder, label, tries = 20) {
    if (player.isInjecting) return false;
    if (player.isActive())  return true;
    player.isInjecting = true;
    try {
      for (let i = 0; i < tries; i++) {
        const el = finder();
        if (el) {
          const ok = await player.show(el);
          if (ok) L(`✓ ${label}`);
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

    // Destroy semua mirror + shared video lama
    playerNPV.destroy();
    playerSL.destroy();
    sharedVideo.destroy();
    lastM3u8 = null;
    if (!artist && !title) return;

    proxyOk = await isProxyAlive();
    if (!proxyOk) { E("Proxy not running! Start with: node animart-proxy.js"); return; }

    const m3u8 = await fetchM3u8(artist, album, title);
    if (!m3u8) { L("No animated artwork for this track"); return; }
    lastM3u8 = m3u8;

    // Transcode SEKALI via SharedVideo
    const loaded = await sharedVideo.load(m3u8);
    if (!loaded) { E("SharedVideo gagal load"); return; }

    // Setelah SharedVideo ready, inject mirror ke semua target
    tryInject(playerNPV, findNpv, "Now Bar");
    tryInject(playerSL,  findSL,  "Spicy Lyrics");
  }

  let observerTimer  = null;
  let lastFullscreen = !!document.fullscreenElement;

  function scheduleReInject(delay = 300) {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      if (!lastM3u8 || !proxyOk || !sharedVideo.ready) return;
      if (!playerNPV.isActive() && !playerNPV.isInjecting)
        tryInject(playerNPV, findNpv, "NPV (re)", 8);
      if (!playerSL.isActive() && !playerSL.isInjecting)
        tryInject(playerSL, findSL, "SL (re)", 8);
    }, delay);
  }

  // Native fullscreen API
  document.addEventListener("fullscreenchange", () => {
    const isFs = !!document.fullscreenElement;
    if (isFs !== lastFullscreen) {
      lastFullscreen = isFs;
      L(`Fullscreen ${isFs ? "entered" : "exited"} — re-injecting (copy canvas, no transcode)`);
      // Hanya destroy mirror canvas, SharedVideo tetap hidup
      playerNPV.destroy();
      playerSL.destroy();
      scheduleReInject(400);
    }
  });

  // Spicetify CSS-based fullscreen (no native fullscreen API event)
  const fsObserver = new MutationObserver(() => {
    const isFs =
      document.documentElement.classList.contains("fullscreen") ||
      document.body.classList.contains("fullscreen") ||
      !!document.querySelector(".Root__fullscreen-page") ||
      !!document.querySelector("[class*='fullscreen-mode']");
    if (isFs !== lastFullscreen) {
      lastFullscreen = isFs;
      L(`Spicetify fullscreen ${isFs ? "entered" : "exited"} — re-injecting (copy canvas, no transcode)`);
      // Hanya destroy mirror canvas, SharedVideo tetap hidup
      playerNPV.destroy();
      playerSL.destroy();
      scheduleReInject(400);
    }
  });
  fsObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  fsObserver.observe(document.body,            { attributes: true, attributeFilter: ["class"] });

  // General DOM observer — re-inject if canvas gets removed
  const observer = new MutationObserver((mutations) => {
    if (!lastM3u8 || !proxyOk) return;
    const relevant = mutations.some(m => {
      for (const node of m.addedNodes)   { if (node.dataset?.animart) return false; }
      for (const node of m.removedNodes) {
        if (node.id === "animart-npv-canvas" || node.id === "animart-sl-canvas") return true;
      }
      const t = m.target;
      if (t?.dataset?.animart || t?.id?.startsWith("animart-")) return false;
      return true;
    });
    if (relevant) scheduleReInject(300);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  L("v2 — single transcode + multi-canvas mirror + rVFC + rAF fallback + VP9");
  proxyOk = await isProxyAlive();
  if (proxyOk) L("✓ Proxy running at localhost:7799");
  else { E("Proxy not running!"); E("Start with: node animart-proxy.js"); }

  Spicetify.Player.addEventListener("songchange", onSongChange);
  await onSongChange();
  L("Ready ✓");

})();
