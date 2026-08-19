
(async function AnimatedArtworkV2() {

  while (!Spicetify?.Player?.addEventListener || !Spicetify?.Player?.data) {
    await new Promise(r => setTimeout(r, 200));
  }

  const PROXY_BASE = "http://localhost:7799";

  const GITHUB_RAW_URL = "https://raw.githubusercontent.com/JustHfizz/Artworks-Animation-Spicy-Lyrics/main/animated-artwork.mjs";

  async function checkAndAutoUpdate() {
    try {

      const resp = await fetch(GITHUB_RAW_URL, {
        signal: AbortSignal.timeout(8000),
        cache : "no-store",
      });
      if (!resp.ok) return;

      const remoteCode = await resp.text();
      if (!remoteCode || remoteCode.length < 100) return;

      const extractVer = code => {
        const m = code.match(/Spicetify Extension\s+v([\d.]+)/i);
        return m ? m[1] : null;
      };
      const remoteVer = extractVer(remoteCode);
      const localVer  = extractVer(document.currentScript?.textContent || "");

      const djb2 = str => {
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
        return (h >>> 0).toString(36);
      };

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
        if (remoteVer && localVer) {
          needsUpdate = remoteVer !== localVer;
        }
      }

      if (!needsUpdate) return;

      L(`Auto-update: mengirim file baru ke proxy untuk disimpan...`);

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

      const script = document.createElement("script");
      script.type  = "module";
      script.text  = remoteCode;
      document.head.appendChild(script);

    } catch (e) {

      E(`Auto-update: ${e.message}`);
    }
  }

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

  class SharedVideo {
    constructor() {
      this.video        = null;
      this.blobUrl      = null;
      this.m3u8Url      = null;
      this.ready        = false;
      this.isLoading    = false;
      this._loadPromise = null;
      this._ac          = null;
    }

    destroy() {

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

    async load(m3u8Url) {
      if (this.ready && this.m3u8Url === m3u8Url) return true;
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

  // NOTE ON SMOOTHNESS: earlier versions mirrored the shared <video> onto each
  // target by capturing frames in JS (createImageBitmap → OffscreenCanvas
  // worker / canvas.drawImage) on every rVFC/rAF tick. That's an extra
  // decode-and-recompress step *per target, per frame*, done on the CPU, and
  // is exactly what caused stutter once more than one target was visible at
  // once (NPV + Album, etc). Real animated-cover extensions (e.g.
  // GuayabR/Motion-Artworks) don't mirror frames at all — they drop an actual
  // <video> element into each container and let the browser's own hardware
  // video decoder + compositor handle it, same as a normal <video> tag on any
  // web page. That's what VideoOverlay does below: no canvas, no worker, no
  // per-frame JS at all — just a positioned, looping <video>.
  class VideoOverlay {
    constructor(id, sharedVideo) {
      this.id          = id;
      this.sv          = sharedVideo;
      this.video       = null;
      this.isPlaying   = false;
      this.isPaused    = false;
      this.isInjecting = false;
    }

    destroy() {
      this.isPlaying   = false;
      this.isPaused    = false;
      this.isInjecting = false;
      document.getElementById(`${this.id}-video`)?.remove();
      this.video = null;
    }

    isActive() {
      if (!this.isPlaying) return false;
      const el = document.getElementById(`${this.id}-video`);
      return !!el && document.body.contains(el);
    }

    pause() {
      if (!this.isPlaying || this.isPaused) return;
      this.isPaused = true;
      this.video?.pause();
      L(`${this.id}: paused (off-screen)`);
    }

    resume() {
      if (!this.isPlaying || !this.isPaused) return;
      if (!this.video) return;
      this.isPaused = false;
      this.syncToMaster();
      this.video.play().catch(() => {});
      L(`${this.id}: resumed (on-screen)`);
    }

    // Each target has its OWN <video> element (that's what makes this
    // smooth — no shared frame-copying), but that means each one plays
    // independently from the moment it was injected. If the animated cover
    // changes color/scene noticeably over its loop, two targets injected a
    // few seconds apart will show visibly different moments of it — which
    // is exactly the "kok beda tampilannya" symptom. Sync everyone's
    // currentTime to the hidden reference <video> inside SharedVideo /
    // SharedVideoLocal (which starts playing the instant the source loads
    // and never stops), so all targets stay locked to the same instant.
    syncToMaster() {
      const master = this.sv?.video;
      if (!this.video || !master) return;
      if (master.paused || master.seeking || master.readyState < 2) return;
      const drift = Math.abs(this.video.currentTime - master.currentTime);
      if (drift > 0.12) {
        try { this.video.currentTime = master.currentTime; } catch (_) {}
      }
    }

    async show(container) {
      this.destroy();
      this.isInjecting = true;

      const blobUrl = this.sv?.blobUrl;
      if (!this.sv?.ready || !blobUrl) {
        E(`${this.id}: SharedVideo not ready`);
        this.isInjecting = false;
        return false;
      }

      try {
        const rect = container.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) {
          throw new Error(`container too small to be a real target (${Math.round(rect.width)}x${Math.round(rect.height)}) — likely matched the wrong element`);
        }

        container.style.position = "relative";
        container.style.overflow = "hidden";

        const video           = document.createElement("video");
        video.id               = `${this.id}-video`;
        video.dataset.animart   = "1";
        video.muted             = true;
        video.loop              = true;
        video.playsInline       = true;
        video.autoplay          = true;
        video.preload           = "auto";
        video.disablePictureInPicture = true;
        // object-fit:cover + inset:0 mirrors the sizing the old canvas used,
        // so containers don't need any layout changes. z-index sits above
        // the underlying <img> so it visually replaces it without removing it.
        // !important guards against host-page CSS rules (e.g. `img, video {
        // width: ... }`) fighting for control of size/position.
        video.style.cssText = "position:absolute!important;inset:0!important;width:100%!important;height:100%!important;object-fit:cover!important;object-position:center!important;border-radius:inherit;z-index:10;pointer-events:none;opacity:0;transition:opacity .2s ease;";
        container.appendChild(video);
        this.video = video;
        video.src  = blobUrl;

        await new Promise((resolve, reject) => {
          video.oncanplay = resolve;
          video.onerror   = () => reject(new Error(`video error: ${video.error?.message || "?"}`));
          setTimeout(() => reject(new Error("timeout canplay")), 8000);
        });

        // Jump to the master clock's current position *before* the first
        // paint, so this target never even flashes a mismatched frame.
        this.syncToMaster();

        await video.play().catch(e => E(`${this.id}: play error:`, e.message));
        video.style.opacity = "1";

        this.isPlaying   = true;
        this.isInjecting = false;
        L(`${this.id}: playing, synced to master (direct <video>, no frame-copy) ✓`);
        return true;
      } catch (e) {
        E(`${this.id}: show failed:`, e.message);
        this.destroy();
        this.isInjecting = false;
        return false;
      }
    }
  }

  const MirrorManager = {
    _mirrors: [],

    register(...mirrors) {
      this._mirrors = mirrors;
    },

    // Was using checkVisibility()/offsetParent, which can misreport a
    // target as "not visible" while it's mid CSS transform/transition —
    // exactly what the Right Panel sidebar does when it slides in/out.
    // That caused it to get paused immediately after every successful
    // inject ("playing, synced to master ✓" followed instantly by
    // "paused (off-screen)"). Use the same rect-size check that
    // firstVisible() already relies on elsewhere in this file — proven
    // reliable for every other target — instead.
    _isVisible(mirror) {
      const el = mirror.video;
      if (!el || !document.body.contains(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 20;
    },

    update() {
      for (const m of this._mirrors) {
        if (!m.isPlaying) continue;

        if (m.id === "animart-npv" && isInFullscreen()) {
          if (!m.isPaused) m.pause();
          continue;
        }
        const visible = this._isVisible(m);
        if (visible && m.isPaused)   { m.resume(); }
        if (!visible && !m.isPaused) { m.pause();  }

        // Each target's <video> decodes independently, so left uncorrected
        // they gradually drift out of sync with each other the longer they
        // play without being paused/resumed — this is why a target that's
        // been sitting on-screen a while can end up showing a visibly
        // different moment of the clip than one injected more recently.
        // Re-sync everyone to the master clock on every visibility poll.
        if (!m.isPaused && typeof m.syncToMaster === "function") m.syncToMaster();
      }
    },
  };

  const LocalArtwork = {

    _store: new Map(),

    set(uri, file) {

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
      this.blobUrl = null;
    }

    async load(blobUrl, mimeType) {
      this.destroy();
      this.blobUrl = blobUrl;

      const needsTranscode = mimeType !== "video/webm";
      let   playUrl = blobUrl;

      if (needsTranscode) {
        L(`SharedVideoLocal: transcode ${mimeType} → WebM via proxy`);
        try {

          const rawBuf = await fetch(blobUrl).then(r => r.arrayBuffer());
          const resp = await fetch(`${PROXY_BASE}/local-transcode`, {
            method: "POST",
            headers: { "Content-Type": mimeType },
            body: rawBuf,
            signal: AbortSignal.timeout(120000),
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
      this.video   = video;
      // Overlays read this.blobUrl directly to create their own <video> tags,
      // so it must always point at something actually playable — the
      // transcoded WebM when a transcode happened, not the original upload.
      this.blobUrl = playUrl;
      video.src    = playUrl;

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

      const btn = document.getElementById("animart-local-btn");
      if (btn) {
        const siblings = [...btn.parentElement.querySelectorAll("button")].filter(b => b !== btn);
        return siblings[siblings.length - 1] || null;
      }

      for (const barSel of [".main-topBar-container","[data-testid='top-bar']",".Root__top-bar","[class*='topBar']"]) {
        const bar = document.querySelector(barSel);
        if (!bar) continue;
        const btns = [...bar.querySelectorAll("button")].filter(b => b.querySelector("svg") && b.offsetParent);
        if (btns.length) return btns[btns.length - 1];
      }
      return null;
    },

    _cloneStyleFrom(srcEl) {

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

    // Ambil bentuk (radius/border/blur) dari tombol marketplace yang sudah ada di UI,
    // supaya panel "Local Artwork" ikut mengikuti tema yang sedang terpasang di Spotify,
    // bukan cuma nilai warna generik.
    _getReferenceShape() {
      const mktBtn = this._findMarketplaceBtn();
      if (!mktBtn) return null;
      return this._cloneStyleFrom(mktBtn);
    },

    // Hitung radius/border/blur panel berdasarkan referensi tombol marketplace + tema.
    // Dipisah jadi helper supaya bisa dipakai ulang baik saat panel pertama dibuat
    // maupun saat tema Spicetify berganti dan panel perlu disegarkan (_applyTheme).
    _computePanelShape(theme) {
      const ref = this._getReferenceShape();
      let finalRadius = theme.panelRadius;
      let finalBorder = `1px solid ${theme.borderC}`;
      let finalBlur   = theme.blur;

      if (ref) {
        const parsePx = (val) => {
          const m = String(val || "").match(/[\d.]+/);
          return m ? parseFloat(m[0]) : null;
        };
        const refRadiusPx = parsePx(ref.borderRadius);
        if (refRadiusPx) {
          finalRadius = `${Math.max(10, Math.round(refRadiusPx * 1.6))}px`;
        }
        if (ref.border && !/^0px|none/.test(ref.border)) finalBorder = ref.border;
        if (ref.backdropFilter) finalBlur = ref.backdropFilter;
      }
      return { finalRadius, finalBorder, finalBlur };
    },

    // Segarkan warna & bentuk tombol + panel memakai tema Spicetify yang sedang aktif
    // SEKARANG (bukan yang tersimpan saat elemen pertama dibuat). Dipanggil manual
    // sekali di awal, dan otomatis lewat _startThemeWatcher() tiap kali tema berganti.
    _applyTheme() {
      const theme = this._getThemeColors();

      if (this._btn && document.body.contains(this._btn)) {
        this._btn._theme = theme;
        if (!this._btn._usedRealClasses && !this._btn._active) {
          this._btn.style.background  = theme.btnC;
          this._btn.style.borderColor = theme.borderC;
        }
      }

      const panel = document.getElementById("animart-local-panel");
      if (panel) {
        const { finalRadius, finalBorder, finalBlur } = this._computePanelShape(theme);
        Object.assign(panel.style, {
          background:           theme.bg,
          color:                theme.textC,
          border:               finalBorder,
          borderRadius:         finalRadius,
          backdropFilter:       finalBlur,
          WebkitBackdropFilter: finalBlur,
        });
        panel.style.setProperty("--animart-radius",            finalRadius);
        panel.style.setProperty("--animart-btn-bg",             theme.btnC);
        panel.style.setProperty("--animart-btn-border",         theme.borderC);
        panel.style.setProperty("--animart-btn-hover-bg",       theme.btnHoverBg);
        panel.style.setProperty("--animart-btn-hover-border",   theme.btnHoverBorder);
        panel.style.setProperty("--animart-status-bg",          theme.statusBg);
        panel.style.setProperty("--animart-status-border",      theme.statusBorder);
      }
    },

    // Pantau pergantian tema Spicetify secara langsung (tanpa perlu reload Spotify):
    // kebanyakan tema menerapkan warnanya lewat custom property di :root (style attr)
    // atau lewat penggantian stylesheet di <head>, jadi kita amati keduanya.
    _startThemeWatcher() {
      if (this._themeObserver) return;
      let debounceTimer = null;
      const scheduleRefresh = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this._applyTheme(), 200);
      };

      this._themeObserver = new MutationObserver(scheduleRefresh);
      this._themeObserver.observe(document.documentElement, {
        attributes: true, attributeFilter: ["style", "class"],
      });
      this._themeObserver.observe(document.head, {
        childList: true, subtree: true,
      });
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
      const theme = this._getThemeColors();
      const btn = document.createElement("button");
      btn.id    = "animart-local-btn";
      btn.title = "Local Artwork";
      btn.setAttribute("aria-label", "Local Artwork");

      // Pakai className ASLI tombol marketplace apa adanya supaya tombol otomatis
      // mendapat desain + efek (liquify-glass, radius, hover/active state, termasuk
      // "chip" bulat yang diberikan tema lewat class globalNav/navLink) langsung dari
      // CSS tema yang sedang aktif. Class ini aman dipakai ulang: Spotify adalah SPA
      // React, navigasi/klik diikat ke elemen lewat handler React langsung — bukan
      // lewat delegasi berbasis className secara global — jadi tidak memicu navigasi
      // tak sengaja. Kalau karena suatu hal class-nya kosong, tetap fallback ke
      // pendekatan lama supaya tombol tidak polos tanpa styling sama sekali.
      const mktClasses = (mktBtn.className || "").split(/\s+/).filter(Boolean);
      const usedRealClasses = mktClasses.length > 0;
      if (usedRealClasses) btn.className = mktClasses.join(" ");

      const encoreId = mktBtn.getAttribute("data-encore-id");
      if (encoreId) btn.setAttribute("data-encore-id", encoreId);
      const liquifyAttr = mktBtn.getAttribute("data-liquify");
      if (liquifyAttr) btn.setAttribute("data-liquify", liquifyAttr);

      // Bungkus ikon dengan struktur <span> yang sama seperti tombol asli (kalau
      // ada) supaya posisi/centering ikon ikut aturan tema. SVG kita TIDAK ikut
      // memakai class/style svg tombol asli — ikon marketplace itu icon-line
      // sederhana 1 shape dengan var ukuran Encore tertentu, sedangkan ikon kita
      // custom multi-shape sendiri; memaksakan class/style itu ke ikon kita
      // membuat proporsinya rusak (gepeng/terpotong).
      const mktIconWrapper = mktBtn.querySelector(":scope > span");
      const iconHtml = this._iconSVG(20);
      if (mktIconWrapper) {
        const wrapClass = mktIconWrapper.getAttribute("class") || "";
        btn.innerHTML = `<span aria-hidden="true"${wrapClass ? ` class="${wrapClass}"` : ""}>${iconHtml}</span>`;
      } else {
        btn.innerHTML = iconHtml;
      }

      const parsePx = (val, fallback) => {
        const m = String(val || "").match(/[\d.]+/);
        return m ? parseFloat(m[0]) : fallback;
      };

      // Simpan warna tema & flag pendekatan yang dipakai, supaya handler hover di
      // bawah dan _applyTheme() tahu apakah harus ikut menimpa warna (fallback) atau
      // membiarkan CSS class asli yang mengatur (pendekatan utama).
      btn._theme = theme;
      btn._usedRealClasses = usedRealClasses;

      const baseStyle = {
        display:         "inline-flex",
        alignItems:      "center",
        justifyContent:  "center",
        margin:          "0 2px",
        cursor:          "pointer",
        flexShrink:      "0",
        WebkitAppRegion: "no-drag",
        boxSizing:       "border-box",
      };

      if (usedRealClasses) {
        // Class Encore-nya sendiri kadang punya ukuran default yang beda tergantung
        // konteks parent (mis. medium vs large), jadi lebar/tinggi tetap kita paksa
        // sama persis dengan tombol marketplace supaya chip-nya benar-benar sejajar
        // dan selebar tombol lain di toolbar — sisanya (radius, background, efek
        // liquify-glass, hover/active) tetap diserahkan ke class asli.
        Object.assign(baseStyle, {
          width:    s.width,
          height:   s.height,
          minWidth: s.minWidth,
        });
        baseStyle.transition = "transform 0.12s cubic-bezier(0.34,1.56,0.64,1)";
      } else {
        const btnWidthPx  = parsePx(s.width, 36);
        const btnHeightPx = parsePx(s.height, 36);
        const baseSizePx  = Math.min(btnWidthPx, btnHeightPx) || 36;
        const btnRadius = `${Math.max(8, Math.round(baseSizePx * 0.32))}px`;
        Object.assign(baseStyle, {
          width:               s.width,
          height:              s.height,
          minWidth:            s.minWidth,
          borderRadius:        btnRadius,
          background:          theme.btnC,
          border:              `1px solid ${theme.borderC}`,
          boxShadow:           "none",
          padding:             s.padding,
          color:               s.color,
          backdropFilter:      "blur(8px)",
          WebkitBackdropFilter:"blur(8px)",
          transition:          "background 0.18s ease, border-color 0.18s ease, transform 0.12s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.18s ease, color 0.15s",
        });
      }

      Object.assign(btn.style, baseStyle);

      btn.addEventListener("mouseenter", () => {
        if (!usedRealClasses && !btn._active) {
          btn.style.background   = btn._theme.btnHoverBg;
          btn.style.borderColor  = btn._theme.btnHoverBorder;
        }
        btn.style.transform = "scale(1.08)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.transform = "scale(1)";
        if (!usedRealClasses && !btn._active) {
          btn.style.background  = btn._theme.btnC;
          btn.style.borderColor = btn._theme.borderC;
        }
      });

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopImmediatePropagation();

        btn.style.transform = "scale(0.88)";
        btn.style.transition = "transform 0.08s cubic-bezier(0.2,0,0.4,1)";
        setTimeout(() => {
          btn.style.transform = "scale(1)";
          btn.style.transition = "transform 0.18s cubic-bezier(0.34,1.56,0.64,1)";
        }, 80);
      });
      btn.addEventListener("click",     (e) => { e.preventDefault(); e.stopImmediatePropagation(); this.toggle(); });

      mktBtn.insertAdjacentElement("afterend", btn);
      this._btn = btn;
      L("LocalUI: button mounted ✓");
      return btn;
    },

    _getThemeColors() {
      const cssVar = (name, fallback = "") => {
        const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return val || fallback;
      };

      const liquifyPopupSelectors = [
        ".main-contextMenu-menu",
        "[data-testid='context-menu']",
        "[class*='contextMenu'][class*='menu']",
        ".main-card-card",
        "[class*='popup'][class*='liquify']",
        ".GenericModal__overlay [class*='Modal']",
        ".main-trackCreditsModal-container",
      ];
      let liveEl = null;
      let glassBgVar = "";

      // Cari dulu secara GENERIK: elemen apa pun yang dipakai tema untuk kartu kaca
      // (punya class "liquify-glass" / atribut "data-liquify"), yang memang sedang
      // benar-benar tampil (bukan varian tersembunyi/opacity:0). Ini lebih tahan
      // banting dibanding daftar selector tetap di bawah, karena tidak bergantung
      // pada nama class spesifik yang bisa beda-beda tiap tema/versi Spotify —
      // cukup ambil langsung dari div nyata yang dipakai tema yang sedang aktif.
      const glassEls = document.querySelectorAll(".liquify-glass, [data-liquify]");
      for (const el of glassEls) {
        if (!el.offsetParent) continue;
        const cs = getComputedStyle(el);
        if (parseFloat(cs.opacity) < 0.5) continue;
        const bgVar   = cs.getPropertyValue("--background-base").trim();
        const hasBg   = cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)";
        const hasBlur = cs.backdropFilter && cs.backdropFilter !== "none";
        if (bgVar || hasBg || hasBlur) { liveEl = el; glassBgVar = bgVar; break; }
      }

      // Kalau tidak ketemu (mis. belum ada elemen liquify yang aktif saat ini),
      // baru coba daftar selector popup/modal tetap seperti sebelumnya.
      if (!liveEl) {
        for (const sel of liquifyPopupSelectors) {
          const el = document.querySelector(sel);
          if (el && getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)") { liveEl = el; break; }
        }
      }

      let liveBg = "", liveRadius = "", liveBlur = "", liveBorder = "";
      if (liveEl) {
        const cs = getComputedStyle(liveEl);
        liveBg     = glassBgVar || cs.backgroundColor;
        liveRadius = cs.borderRadius;
        liveBlur   = cs.backdropFilter && cs.backdropFilter !== "none" ? cs.backdropFilter : "";
        liveBorder = cs.borderColor && cs.borderWidth !== "0px" ? cs.borderColor : "";
      }

      const spiceCard    = cssVar("--spice-card");
      const spiceSidebar = cssVar("--spice-sidebar");
      const spiceMain    = cssVar("--spice-main");
      const spiceText    = cssVar("--spice-text");
      const spiceSub     = cssVar("--spice-subtext");
      const spiceRadius  = cssVar("--spice-border-radius") || cssVar("--liquify-border-radius");

      const spiceBg = spiceCard || spiceSidebar || spiceMain;

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

      const source = liveBg || spiceBg || rawBg;

      const bg      = toRgba(source, 0.55) || "rgba(24,24,24,0.55)";
      const borderC = toRgba(liveBorder || source, liveBorder ? 0.9 : 0.20) || "rgba(255,255,255,0.13)";
      const btnC    = toRgba(source, 0.10) || "rgba(255,255,255,0.06)";

      // Varian untuk elemen "tombol" di dalam panel (status bar, upload label) supaya
      // ikut warna tema, bukan abu-abu/putih tetap — termasuk state hover-nya.
      const btnHoverBg     = toRgba(source, 0.20) || "rgba(255,255,255,0.12)";
      const btnHoverBorder = toRgba(liveBorder || source, liveBorder ? 1 : 0.34) || "rgba(255,255,255,0.22)";
      const statusBg       = toRgba(source, 0.09) || "rgba(255,255,255,0.07)";
      const statusBorder   = toRgba(liveBorder || source, liveBorder ? 0.55 : 0.12) || "rgba(255,255,255,0.09)";

      const subC = spiceSub
        ? (toRgba(spiceSub, 0.85) || "rgba(255,255,255,0.55)")
        : (toRgba(textC, 0.60)    || "rgba(255,255,255,0.55)");

      const panelRadius = liveRadius || spiceRadius || "18px";
      const blur         = liveBlur || "blur(28px) saturate(180%)";

      L("theme src=" + (source||"none").slice(0,25) + " radius=" + panelRadius + " text=" + textC.slice(0,20));
      return { bg, textC, subC, btnC, borderC, panelRadius, blur, btnHoverBg, btnHoverBorder, statusBg, statusBorder };
    },

    _buildPanel() {
      document.getElementById("animart-local-panel")?.remove();

      if (!document.getElementById("animart-panel-style")) {
        const style = document.createElement("style");
        style.id = "animart-panel-style";
        style.textContent = `
          #animart-local-panel {
            font-family: var(--font-family, var(--encore-body-font-stack, 'CircularSp', 'CircularSp-Arab', 'CircularSp-Hebr', 'CircularSp-Cyrl', 'CircularSp-Grek', 'CircularSp-Deva', 'var(--fallback-fonts)', sans-serif));
            position: fixed;
            z-index: 99999;
            padding: 16px 16px 13px;
            width: 268px;
            user-select: none;

            background: var(--spice-card, var(--spice-main, rgba(24,24,24,0.85)));
            color: var(--spice-text, #ffffff);
            border: 1px solid var(--spice-button-disabled, rgba(255,255,255,0.13));
            border-radius: var(--spice-border-radius, 18px);
            backdrop-filter: blur(28px) saturate(180%);
            -webkit-backdrop-filter: blur(28px) saturate(180%);
            box-shadow:
              0 8px 32px rgba(0,0,0,0.45),
              0 2px 8px rgba(0,0,0,0.25),
              inset 0 1px 0 rgba(255,255,255,0.08);
            animation: animart-panel-in 0.18s cubic-bezier(0.34,1.4,0.64,1) both;
          }
          @keyframes animart-panel-in {
            from { opacity:0; transform: translateY(6px) scale(0.97); }
            to   { opacity:1; transform: translateY(0)   scale(1);    }
          }
          #animart-local-status {
            background: var(--spice-highlight, rgba(255,255,255,0.07));
            border: 1px solid var(--spice-button-disabled, rgba(255,255,255,0.09));
            border-radius: calc(var(--spice-border-radius, 18px) * 0.55);
            color: var(--spice-subtext, rgba(255,255,255,0.55));
            font-size: 11px;
            padding: 6px 10px;
            margin-bottom: 10px;
            line-height: 1.4;
          }
          .animart-upload-label {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 9px 11px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            border: 1px solid var(--spice-button-disabled, rgba(255,255,255,0.11));
            border-radius: calc(var(--spice-border-radius, 18px) * 0.65);
            color: var(--spice-text, #ffffff);
            background: var(--spice-highlight, rgba(255,255,255,0.05));
            transition: filter 0.18s ease, transform 0.12s ease;
          }
          .animart-upload-label:hover {
            filter: brightness(1.35);
            transform: translateY(-1px);
          }
          .animart-upload-label:active {
            transform: scale(0.97);
          }
          #animart-reset-btn {
            border-radius: calc(var(--spice-border-radius, 18px) * 0.65);
            transition: filter 0.18s ease, transform 0.1s ease;
          }
          #animart-reset-btn:not(:disabled):hover {
            filter: brightness(1.3);
            transform: translateY(-1px);
          }
          #animart-panel-divider {
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--spice-button-disabled, rgba(255,255,255,0.12)), transparent);
            margin: 8px 0;
          }
          #animart-local-btn.animart-active {
            box-shadow: 0 0 0 2px var(--spice-button, #1DB954),
                        0 0 12px rgba(var(--spice-rgb-button, 29,185,84), 0.35) !important;
          }
        `;
        document.head.appendChild(style);
      }

      const { bg, textC, subC, btnC, borderC, panelRadius, blur, btnHoverBg, btnHoverBorder, statusBg, statusBorder } = this._getThemeColors();

      // Turunkan bentuk panel (radius/border/blur) dari tombol marketplace kalau ketemu,
      // supaya "bentuk" panel konsisten dengan tema yang terpasang — warna tetap dari
      // _getThemeColors() karena warna tombol kecil biasanya kurang kontras kalau
      // dipakai langsung sebagai background panel sebesar ini.
      const { finalRadius, finalBorder, finalBlur } = this._computePanelShape({ panelRadius, borderC, blur });

      const panel = document.createElement("div");
      panel.id = "animart-local-panel";
      Object.assign(panel.style, {
        position:       "fixed",
        zIndex:         "99999",
        padding:        "16px 16px 13px",
        width:          "268px",
        userSelect:     "none",
        display:        "none",

        background:           bg,
        color:                textC,
        border:               finalBorder,
        borderRadius:         finalRadius,
        backdropFilter:       finalBlur,
        WebkitBackdropFilter: finalBlur,
      });
      panel.style.setProperty("--animart-radius", finalRadius);
      panel.style.setProperty("--animart-btn-bg", btnC);
      panel.style.setProperty("--animart-btn-border", borderC);
      panel.style.setProperty("--animart-btn-hover-bg", btnHoverBg);
      panel.style.setProperty("--animart-btn-hover-border", btnHoverBorder);
      panel.style.setProperty("--animart-status-bg", statusBg);
      panel.style.setProperty("--animart-status-border", statusBorder);

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
      const ph  = 230;

      let left = r.left + r.width / 2 - pw / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));

      let top  = r.top - ph - 8;

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

      document.addEventListener("click", (e) => {
        if (!this._open) return;
        const btn = document.getElementById("animart-local-btn");
        const pnl = document.getElementById("animart-local-panel");
        if (btn && btn.contains(e.target)) return;
        if (pnl && pnl.contains(e.target)) return;
        this.close();
      }, false);
    },
  };

  let currentUri  = null;
  let lastM3u8    = null;
  let lastSource  = null;
  let proxyOk     = false;
  const sharedVideo      = new SharedVideo();
  const sharedVideoLocal = new SharedVideoLocal();
  const playerNPV        = new VideoOverlay("animart-npv",   sharedVideo);
  const playerSL         = new VideoOverlay("animart-sl",    sharedVideo);
  const playerAlbum      = new VideoOverlay("animart-album", sharedVideo);
  const playerMini       = new VideoOverlay("animart-mini",  sharedVideo);
  const playerRightPanel = new VideoOverlay("animart-right", sharedVideo);

  MirrorManager.register(playerNPV, playerSL, playerAlbum, playerMini, playerRightPanel);

  function switchToVideo(sv) {
    playerNPV.sv        = sv;
    playerSL.sv         = sv;
    playerAlbum.sv      = sv;
    playerMini.sv       = sv;
    playerRightPanel.sv = sv;
  }

  async function applyLocalArtwork(uri, file) {
    if (!uri) return;

    const blobUrl = LocalArtwork.set(uri, file);

    playerNPV.destroy();
    playerSL.destroy();
    playerAlbum.destroy();
    playerMini.destroy();
    playerRightPanel.destroy();

    const ok = await sharedVideoLocal.load(blobUrl, file.type);
    if (!ok) { E("LocalArtwork: failed to load local video"); return; }

    switchToVideo(sharedVideoLocal);

    tryInjectNpv("NPV (local)");
    tryInject(playerSL,         findSL,         "SL    (local)");
    tryInject(playerAlbum,      findAlbumPage,  "Album (local)");
    tryInject(playerMini,       findMiniPlayer, "Mini  (local)");
    tryInject(playerRightPanel, findRightPanel, "Right (local)");
    L(`LocalArtwork: active for ${uri}`);
  }

  async function resetToApiArtwork(uri) {
    LocalArtwork.remove(uri);

    playerNPV.destroy();
    playerSL.destroy();
    playerAlbum.destroy();
    playerMini.destroy();
    playerRightPanel.destroy();
    sharedVideoLocal.destroy();

    switchToVideo(sharedVideo);

    if (!sharedVideo.ready) {

      if (lastM3u8) {
        const loaded = await sharedVideo.load(lastM3u8);
        if (!loaded) { E("Reset: sharedVideo failed to reload"); return; }
      } else {
        L("Reset: no API artwork for this track");
        return;
      }
    }

    tryInjectNpv("NPV (reset)");
    tryInject(playerSL,         findSL,         "SL    (reset)");
    tryInject(playerAlbum,      findAlbumPage,  "Album (reset)");
    tryInject(playerMini,       findMiniPlayer, "Mini  (reset)");
    tryInject(playerRightPanel, findRightPanel, "Right (reset)");
    L(`LocalArtwork: reset to API for ${uri}`);
  }

  async function fetchM3u8(artist, album, title) {
    const params = new URLSearchParams({ artist: artist || "", album: album || "", title: title || "" });
    try {
      const resp = await fetch(`${PROXY_BASE}/artwork?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) { E(`/artwork error: ${resp.status}`); return null; }
      const json = await resp.json();
      return json.m3u8 ? { m3u8: json.m3u8, source: json.source || null } : null;
    } catch (e) { E("fetchM3u8:", e.message); return null; }
  }

  // Picks the first candidate element that actually has a plausible
  // on-screen size, instead of just the first one that matches in the DOM.
  // Root cause of the NPV bug: `.main-coverSlotExpanded-container` exists in
  // the DOM at all times (even when unused, at 0×0), so a plain `||` chain
  // would "find" it and never fall through to the real, correctly-sized
  // `.MediaImageContainer` — confirmed via live debug (0×0 vs 494×494).
  const firstVisible = (...getters) => {
    for (const get of getters) {
      let el;
      try { el = get(); } catch (_) { el = null; }
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 20 && r.height > 20) return el;
    }
    return null;
  };

  const findNpv = () =>
    firstVisible(
      () => document.querySelector(".MediaImageContainer"),
      () => document.querySelector(".main-coverSlotExpanded-container"),
      () => document.querySelector("[data-testid='cover-art-image']")?.closest("[data-testid='cover-art']"),
    );

  // Bottom-left mini player (the small thumbnail next to the track title in
  // the playback bar). This used to share a finder with findNpv() above —
  // since a finder can only ever return ONE element, whichever selector
  // matched first "won" and the mini player never got its own video.
  const findMiniPlayer = () =>
    firstVisible(
      () => document.querySelector("[data-testid='now-playing-widget'] [data-testid='cover-art']"),
      () => document.querySelector(".main-nowPlayingBar-left [data-testid='cover-art']"),
      () => document.querySelector(".main-nowPlayingWidget-coverArt"),
    );

  // Right-hand "Now Playing" sidebar panel (queue / about-the-artist panel).
  const findRightPanel = () =>
    firstVisible(
      () => document.querySelector("[data-testid='NPV_Panel'] [data-testid='cover-art']"),
      () => document.querySelector("[data-testid='right-sidebar'] [data-testid='cover-art']"),
      () => document.querySelector(".main-nowPlayingView-coverArt"),
      () => document.querySelector(".main-nowPlayingView-nowPlayingWidget [data-testid='cover-art']"),
    );

  const findSL = () => {
    // [class*='SpicyLyrics'] used to also match a persistent 1x1px
    // ".SpicyLyricsFontPixel" helper span that exists on the page at all
    // times (a font-loading trick), not the actual lyrics cover — which is
    // why SL kept "succeeding" against a 1x1 target. Excluding *Pixel* class
    // names and requiring a plausible on-screen size fixes that.
    const isRealCandidate = (el) => {
      if (!el || /pixel/i.test(el.className || "")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 20;
    };

    const root =
      document.querySelector("#SpicyLyricsPage") ||
      document.querySelector(".spicylyrics-page") ||
      document.querySelector("[data-spicylyrics]") ||
      document.querySelector(".Root__fullscreen-page #SpicyLyricsPage") ||
      document.querySelector("[class*='fullscreen'] #SpicyLyricsPage") ||
      [...document.querySelectorAll("[class*='SpicyLyrics']")].find(isRealCandidate) ||
      null;
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

  // Album page (the big hero cover art shown at the top of an /album/<id> page).
  // Only inject there when the album page currently open actually belongs to the
  // track that's playing — otherwise the animated cover would show on whatever
  // unrelated album the user happens to be browsing.
  const currentAlbumId = () => {
    const track    = Spicetify.Player.data?.item;
    const albumUri = track?.metadata?.album_uri || track?.album?.uri || "";
    const parts     = albumUri.split(":");
    return parts.length === 3 ? parts[2] : null;
  };

  const findAlbumPage = () => {
    const albumId = currentAlbumId();
    if (albumId && !location.pathname.startsWith(`/album/${albumId}`)) return null;
    // If we can't resolve an album id from the metadata, fall back to "any
    // album page" rather than refusing to inject at all.
    if (!albumId && !location.pathname.startsWith("/album/")) return null;

    return firstVisible(
      () => document.querySelector("[data-testid='entity-header'] [data-testid='cover-art']"),
      () => document.querySelector("[data-testid='entity-header'] [data-testid='cover-art-image']")?.closest("[data-testid='cover-art']"),
      () => document.querySelector("[data-testid='entityImage']"),
      () => document.querySelector(".main-entityHeader-imageContainer"),
      () => document.querySelector("[class*='entityHeader'][class*='mage']"),
      () => document.querySelector(".main-entityHeader-image"),
    );
  };

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

    playerNPV.destroy();
    playerSL.destroy();
    playerAlbum.destroy();
    playerMini.destroy();
    playerRightPanel.destroy();
    sharedVideo.destroy();
    sharedVideoLocal.destroy();
    lastM3u8   = null;
    lastSource = null;

    switchToVideo(sharedVideo);

    LocalUI._updatePanel?.();

    if (!artist && !title) return;

    const localEntry = LocalArtwork.get(uri);
    if (localEntry) {
      L(`LocalArtwork: found for ${uri} — skip API`);
      lastSource = "local";
      switchToVideo(sharedVideoLocal);
      const ok = await sharedVideoLocal.load(localEntry.blobUrl, localEntry.type);
      if (ok) {
        tryInjectNpv("NPV (local)");
        tryInject(playerSL,         findSL,         "SL    (local)");
        tryInject(playerAlbum,      findAlbumPage,  "Album (local)");
        tryInject(playerMini,       findMiniPlayer, "Mini  (local)");
        tryInject(playerRightPanel, findRightPanel, "Right (local)");
      }

      proxyOk = await isProxyAlive();
      if (proxyOk) {
        fetchM3u8(artist, album, title).then(result => {
          if (result) { lastM3u8 = result.m3u8; L(`LocalArtwork: API m3u8 cached for reset`); }
        });
      }
      return;
    }

    proxyOk = await isProxyAlive();
    if (!proxyOk) { E("Proxy not running! Start with: node animart-proxy.js"); return; }

    const result = await fetchM3u8(artist, album, title);
    if (!result) { L("No animated artwork for this track"); return; }
    lastM3u8   = result.m3u8;
    lastSource = result.source;

    const loaded = await sharedVideo.load(lastM3u8);
    if (!loaded) { E("SharedVideo failed to load"); return; }

    tryInjectNpv("Now Bar");
    tryInject(playerSL,         findSL,         "Spicy Lyrics");
    tryInject(playerAlbum,      findAlbumPage,  "Album Page");
    tryInject(playerMini,       findMiniPlayer, "Mini Player");
    tryInject(playerRightPanel, findRightPanel, "Right Panel");
  }

  let observerTimer  = null;
  let lastFullscreen = !!document.fullscreenElement;

  function isInFullscreen() {
    return (
      !!document.fullscreenElement ||
      document.documentElement.classList.contains("fullscreen") ||
      document.body.classList.contains("fullscreen") ||
      !!document.querySelector(".Root__fullscreen-page") ||
      !!document.querySelector("[class*='fullscreen-mode']")
    );
  }

  function tryInjectNpv(label, tries) {
    if (isInFullscreen()) { playerNPV.pause(); return; }
    tryInject(playerNPV, findNpv, label, tries);
  }

  function scheduleReInject(delay = 300) {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      const hasLocal = currentUri && LocalArtwork.has(currentUri);
      const activeSV = hasLocal ? sharedVideoLocal : sharedVideo;
      if (!activeSV.ready) return;
      if (!hasLocal && (!lastM3u8 || !proxyOk)) return;

      if (isInFullscreen()) {
        if (playerNPV.isPlaying && !playerNPV.isPaused) playerNPV.pause();
      } else if (!playerNPV.isActive() && !playerNPV.isInjecting) {
        tryInjectNpv("NPV (re)", 8);
      }
      if (!playerSL.isActive() && !playerSL.isInjecting)
        tryInject(playerSL, findSL, "SL (re)", 8);
      if (!playerAlbum.isActive() && !playerAlbum.isInjecting)
        tryInject(playerAlbum, findAlbumPage, "Album (re)", 8);
      if (!playerMini.isActive() && !playerMini.isInjecting)
        tryInject(playerMini, findMiniPlayer, "Mini (re)", 8);
      if (!playerRightPanel.isActive() && !playerRightPanel.isInjecting)
        tryInject(playerRightPanel, findRightPanel, "Right (re)", 8);
    }, delay);
  }

  LocalUI.initOutsideListener();
  LocalUI._startThemeWatcher();

  setInterval(() => LocalUI.tryMount(), 500);

  setTimeout(() => LocalUI.tryMount(), 300);
  setTimeout(() => LocalUI.tryMount(), 1000);
  setTimeout(() => LocalUI.tryMount(), 2500);

  document.addEventListener("fullscreenchange", () => {
    const isFs = !!document.fullscreenElement;
    if (isFs !== lastFullscreen) {
      lastFullscreen = isFs;
      L(`Fullscreen ${isFs ? "entered" : "exited"} — re-injecting`);
      if (isFs) {

        playerNPV.pause();
        playerSL.destroy();
      } else {
        playerNPV.destroy();
        playerSL.destroy();
      }

      scheduleReInject(150);
    }
  });

  const fsObserver = new MutationObserver(() => {
    const isFs = isInFullscreen();
    if (isFs !== lastFullscreen) {
      lastFullscreen = isFs;
      L(`Spicetify fullscreen ${isFs ? "entered" : "exited"} — re-injecting`);
      if (isFs) {
        playerNPV.pause();
        playerSL.destroy();
      } else {
        playerNPV.destroy();
        playerSL.destroy();
      }
      scheduleReInject(150);
    }
  });
  fsObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  fsObserver.observe(document.body,            { attributes: true, attributeFilter: ["class"] });

  setInterval(() => {
    if (!lastM3u8 && !(currentUri && LocalArtwork.has(currentUri))) return;
    const npvGone   = playerNPV.isPlaying   && !playerNPV.isActive()   && !playerNPV.isInjecting;
    const slGone    = playerSL.isPlaying    && !playerSL.isActive()    && !playerSL.isInjecting;
    const albumGone = playerAlbum.isPlaying && !playerAlbum.isActive() && !playerAlbum.isInjecting;
    const miniGone  = playerMini.isPlaying       && !playerMini.isActive()       && !playerMini.isInjecting;
    const rightGone = playerRightPanel.isPlaying && !playerRightPanel.isActive() && !playerRightPanel.isInjecting;
    if (npvGone || slGone || albumGone || miniGone || rightGone) scheduleReInject(50);
  }, 250);

  // The album hero cover only exists in the DOM once the user *navigates* to
  // an album page — there's no songchange/fullscreen event for that, so poll
  // for it directly (same pattern already used for LocalUI.tryMount below).
  // Uses playerAlbum.show() directly (not the tryInject helper) so a page
  // that simply isn't an album page doesn't spam "container not found" logs.
  setInterval(() => {
    if (!lastM3u8 && !(currentUri && LocalArtwork.has(currentUri))) return;
    if (!location.pathname.startsWith("/album/")) return;
    if (playerAlbum.isActive() || playerAlbum.isInjecting) return;
    const el = findAlbumPage();
    if (el) playerAlbum.show(el).then(ok => { if (ok) { L("✓ Album (poll)"); MirrorManager.update(); } });
  }, 1000);

  // Same reasoning as the album poll above: the right-hand Now Playing panel
  // can be toggled open/closed by the user at any time, independent of song
  // changes, so it needs its own quiet poll too.
  setInterval(() => {
    if (!lastM3u8 && !(currentUri && LocalArtwork.has(currentUri))) return;
    if (playerRightPanel.isActive() || playerRightPanel.isInjecting) return;
    const el = findRightPanel();
    if (el) playerRightPanel.show(el).then(ok => { if (ok) { L("✓ Right (poll)"); MirrorManager.update(); } });
  }, 1000);

  let _uiTimer = null;
  const uiObserver = new MutationObserver(() => {
    clearTimeout(_uiTimer);
    _uiTimer = setTimeout(() => LocalUI.tryMount(), 300);
  });
  uiObserver.observe(document.body, { childList: true, subtree: false });

  setInterval(() => MirrorManager.update(), 800);

  // Debug helper — run window.__animartDebug() in the DevTools console to
  // see exactly which element each target matched, its on-screen size, and
  // its class/data-testid. Paste that output back if a target still looks
  // wrong; guessing selectors blind isn't reliable past this point.
  window.__animartDebug = () => {
    const targets = {
      npv:   typeof findNpv        === "function" ? findNpv()        : null,
      sl:    typeof findSL         === "function" ? findSL()         : null,
      album: typeof findAlbumPage  === "function" ? findAlbumPage()  : null,
      mini:  typeof findMiniPlayer === "function" ? findMiniPlayer() : null,
      right: typeof findRightPanel === "function" ? findRightPanel() : null,
    };
    for (const [name, el] of Object.entries(targets)) {
      if (!el) { console.log(`[AnimArt debug] ${name}: NOT FOUND`); continue; }
      const r = el.getBoundingClientRect();
      console.log(
        `[AnimArt debug] ${name}: ${Math.round(r.width)}x${Math.round(r.height)}px`,
        `class="${el.className}"`, `testid="${el.dataset?.testid || ""}"`,
        el
      );
    }
  };

  L("v2 — single transcode + multi-canvas mirror + rVFC + rAF fallback + VP9");
  proxyOk = await isProxyAlive();
  if (proxyOk) L("✓ Proxy running at localhost:7799");
  else { E("Proxy not running!"); E("Start with: node animart-proxy.js"); }

  Spicetify.Player.addEventListener("songchange", onSongChange);
  await onSongChange();
  L("Ready ✓");

})();
