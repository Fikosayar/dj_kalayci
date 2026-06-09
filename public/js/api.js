/* =========================================================
   api.js — Backend API katmanı
   Gerçek sunucuda /api/* uçlarına bağlanır.
   Önizleme / backend yokken DEMO moduna düşer ki arayüz
   her zaman dolu ve gezilebilir görünsün.
   ========================================================= */

const API = (() => {
  let demo = false;
  const listeners = [];
  const _durCache = {}; // filename → saniye (sunucudan gelen gerçek süreler)

  // --- Demo veri ---------------------------------------------------------
  const DEMO_TRACKS = [
    "Mahmut Orhan - Feel (Original Mix).mp3",
    "Save Me - feat. Eneli.mp3",
    "Mahmut Orhan - 6 Days.mp3",
    "Schwarz - Hero (Sunset Edit).mp3",
    "Anatolian Sunrise - Deep Mix.mp3",
    "Mahmut Orhan - Mood feat. Irina Rimes.mp3",
    "Empire of the Sun - Walking on a Dream.mp3",
    "Bosphorus Nights - Extended.mp3",
    "Mahmut Orhan - Vipava.mp3",
    "Reverie - Late Night Cut.mp3",
    "Olive Tree - Organic House.mp3",
    "Mahmut Orhan & Sena Sener - Tell Me.mp3",
    "Coastline - Sunset Sessions Vol.3.mp3",
    "Whispers of the Aegean.mp3",
    "Mahmut Orhan - Hero feat. Irina Rimes.mp3",
    "Dawn Chorus - Morning Set.mp3",
    "Kayseri Kalaycı - Live Edit.mp3",
    "Golden Hour - Beach Mix.mp3",
  ];

  function seeded(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // Süre: önce sunucudan önbellekteki gerçek süreyi kullan, yoksa sahte üret
  function durationFor(name) {
    if (_durCache[name] && _durCache[name] > 0) return _durCache[name];
    const r = seeded(name + "_dur");
    return 150 + Math.floor(r() * 170); // fallback: 2:30 – 5:20
  }

  // Deterministik dalgaform tepe değerleri (0..1), N adet
  function peaksFor(name, n = 64) {
    const r = seeded(name + "_wave");
    const out = [];
    let prev = 0.5;
    for (let i = 0; i < n; i++) {
      const target = 0.15 + r() * 0.85;
      prev = prev * 0.55 + target * 0.45;           // yumuşat
      const env = Math.sin((i / n) * Math.PI);        // uçlarda alçal
      out.push(Math.max(0.08, Math.min(1, prev * (0.45 + 0.55 * env))));
    }
    return out;
  }

  async function detect() {
    // En fazla 2 deneme yap, sonra demo moda geç
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("/api/music?page=1&limit=1", { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error("bad status");
        await res.json();
        demo = false;
        listeners.forEach(fn => fn(demo));
        return demo;
      } catch (e) {
        if (attempt < 1) {
          await new Promise(r => setTimeout(r, 1000)); // 1sn bekle, tekrar dene
          continue;
        }
        demo = true;
        console.info("[DJ_Kalayci] Backend bulunamadı — DEMO modu aktif.");
      }
    }
    listeners.forEach(fn => fn(demo));
    return demo;
  }

  // --- Public API --------------------------------------------------------
  return {
    onMode(fn) { listeners.push(fn); },
    get isDemo() { return demo; },
    init: detect,
    durationFor,
    peaksFor,

    async getMusic(page, limit, searchParam = '') {
      if (!demo) {
        try {
          const res = await fetch(`/api/music?page=${page}&limit=${limit}${searchParam}`);
          if (!res.ok) throw new Error();
          const data = await res.json();
          // Gelen gerçek süreleri önbelleğe al
          if (data.durations) Object.assign(_durCache, data.durations);
          return data;
        } catch (e) { demo = true; listeners.forEach(fn => fn(true)); }
      }
      const total = DEMO_TRACKS.length;
      const start = (page - 1) * limit;
      return {
        files: DEMO_TRACKS.slice(start, start + limit),
        total,
        totalPages: Math.ceil(total / limit),
        current: page,
      };
    },

    streamURL(filename) { return `/api/music/play/${encodeURIComponent(filename)}`; },
    coverURL(filename) {
      if (demo) return null; // Demo modunda cover endpoint'i yok
      return `/api/music/cover/${encodeURIComponent(filename)}`;
    },

    async getUploadPath() {
      if (demo) return { uploadPath: "/app/uploads" };
      const res = await fetch("/api/settings/upload-path");
      return res.json();
    },
    async setUploadPath(uploadPath) {
      if (demo) return { success: true, uploadPath };
      const res = await fetch("/api/settings/upload-path", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadPath }),
      });
      return res.json();
    },
    async getDirectories(targetPath) {
      if (demo) {
        const sample = ["uploads", "music", "media", "backups", "tmp", ".cache"];
        return { currentPath: targetPath || "/app", directories: sample };
      }
      const url = targetPath ? `/api/directories?path=${encodeURIComponent(targetPath)}` : `/api/directories`;
      const res = await fetch(url);
      return res.json();
    },

    async getDevices() {
      if (demo) {
        return [
          { id: "browser", name: "Kendi Cihazım (Tarayıcı)", icon: "computer", description: "Müzik şu anki cihazınızdan çalar." },
          { id: "debian_alsa", name: "Sunucu Hoparlörü", icon: "speaker", description: "Müzik ana sunucu (Debian) hoparlöründen çalar." },
        ];
      }
      const res = await fetch("/api/devices");
      return res.json();
    },
    async playServer(filename) {
      if (demo) return { success: true };
      return fetch("/api/music/play-server", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      }).then(r => r.json());
    },
    async pauseServer() {
      if (demo) return { success: true };
      return fetch("/api/music/pause-server", { method: "POST" }).then(r => r.json());
    },
    async stopServer() {
      if (demo) return { success: true };
      return fetch("/api/music/stop-server", { method: "POST" }).then(r => r.json());
    },
    async volumeServer(volume) {
      if (demo) return { success: true };
      return fetch("/api/music/volume-server", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ volume })
      }).then(r => r.json());
    },
    async playRadioServer(url, volume) {
      if (demo) return { success: true };
      return fetch("/api/radio/play-server", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, volume })
      }).then(r => r.json());
    },
    async stopRadioServer() {
      if (demo) return { success: true };
      return fetch("/api/radio/stop-server", { method: "POST" }).then(r => r.json());
    },
    async seekServer(percent) {
      if (demo) return { success: true };
      return fetch("/api/music/seek-server", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ percent })
      }).then(r => r.json());
    },
    async statusServer() {
      if (demo) return { isPlaying: false, time: 0, duration: 0 };
      return fetch("/api/music/status-server").then(r => r.json());
    },
    async radioStatus() {
      if (demo) return { isPlaying: false, isReconnecting: false, url: null };
      try {
        const r = await fetch("/api/radio/status");
        return r.ok ? r.json() : { isPlaying: false, isReconnecting: false, url: null };
      } catch { return { isPlaying: false, isReconnecting: false, url: null }; }
    }
  };
})();
