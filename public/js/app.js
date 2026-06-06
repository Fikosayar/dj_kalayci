/* =========================================================
   app.js — Uygulama kabuğu: navigasyon, yükleme, ayarlar,
   cihaz modalı, yön (A/B) anahtarı, başlatma.
   ========================================================= */

const SCREEN_TITLES = { home: "Ana Sayfa", upload: "Müzik Yükle", player: "Oynatıcı", settings: "Ayarlar", library: "Kütüphane", radio: "Radyo" };

document.addEventListener("DOMContentLoaded", async () => {
  initDirection();

  const sm = new ScreenManager("main-content");
  window.sm = sm;

  // Sidebar nav (desktop)
  const nav = document.querySelectorAll(".nav-links li[data-target]");
  nav.forEach((li) => li.addEventListener("click", () => {
    nav.forEach((n) => n.classList.remove("active"));
    li.classList.add("active");
    sm.navigate(li.dataset.target);
  }));

  // Mobile bottom nav
  const mobileNavItems = document.querySelectorAll(".mobile-nav-item[data-target]");
  mobileNavItems.forEach((btn) => btn.addEventListener("click", () => {
    sm.navigate(btn.dataset.target);
  }));

  // Ekran değişince hem sidebar hem mobile nav'ı senkronize et
  window.addEventListener("screenChanged", (e) => {
    const s = e.detail.screen;
    const t = document.getElementById("topbar-title");
    if (t) t.textContent = SCREEN_TITLES[s] || "";

    // Sidebar active
    nav.forEach((n) => n.classList.toggle("active", n.dataset.target === s));

    // Mobile nav active
    mobileNavItems.forEach((btn) => btn.classList.toggle("active", btn.dataset.target === s));

    if (s === "settings") initDirectoryBrowser();
    if (s === "upload") initUpload();
    if (s === "player" || s === "party") Player.init();
    if (s === "library") initLibrary();
    if (s === "radio") initRadio();
    if (s === "home") {
      window._currentArtState = "";
      if (window.updateVisualArt) window.updateVisualArt();
    }
  });

  sm.navigate("home");
  initDeviceModal();
  initSidebarVolume();

  // backend tespiti arka planda — ana sayfayı bloklamasın
  await API.init();
  reflectDemoBadge(API.isDemo);
});

/* ---------------- Radio ---------------- */
function initRadio() {
  const audio = document.getElementById('audio-player');
  let radioPlaying = false;
  let currentStationName = '';
  let currentUrl = '';
  let hls = null;

  // Şu an hangi cihaz seçili?
  function isServerMode() {
    return window.Player && Player.state && Player.state.device !== 'browser';
  }

  // --- UI güncelle ---
  function setStatus(playing, name, statusText) {
    const npName   = document.getElementById('radio-np-name');
    const npStatus = document.getElementById('radio-np-status');
    const npArt    = document.getElementById('radio-np-art');
    const eq       = document.getElementById('radio-eq');
    const playIcon = document.getElementById('radio-play-icon');
    const playLbl  = document.getElementById('radio-play-label');

    if (npName)   npName.textContent   = name || 'Radyo seçin veya URL girin';
    if (npStatus) npStatus.textContent = statusText || 'Bekliyor';
    if (npArt)    npArt.classList.toggle('live', playing);
    if (eq)       eq.style.display     = playing ? 'flex' : 'none';
    if (playIcon) playIcon.textContent = playing ? 'stop' : 'play_arrow';
    if (playLbl)  playLbl.textContent  = playing ? 'Durdur' : 'Oynat';

    document.querySelectorAll('.radio-preset-card').forEach(c => {
      c.classList.toggle('playing', playing && c.dataset.url === currentUrl);
    });

    radioPlaying = playing;
  }

  function loadSavedVol() {
    try {
      const s = JSON.parse(localStorage.getItem('djk_player_v1') || '{}');
      return s.muted ? 0 : (s.volume ?? 0.7);
    } catch { return 0.7; }
  }

  async function resolveStream(url) {
    const lower = url.toLowerCase();
    if (lower.endsWith('.pls') || lower.endsWith('.m3u')) {
      try {
        const res  = await fetch(`/api/radio/resolve?url=${encodeURIComponent(url)}`);
        const data = await res.json();
        return data.streamUrl || url;
      } catch { return url; }
    }
    return url;
  }

  // --- Durdur (her ikisini de) ---
  function stop() {
    // Browser audio durdur
    if (hls) { hls.destroy(); hls = null; }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    // Server radyo durdur
    API.stopRadioServer();
    setStatus(false, currentStationName || '', 'Durdu');
    radioPlaying = false;
    currentUrl = '';
  }

  // Global referanslar — player.js radyo durumunu sorgulayabilsin
  window.__radioStop = stop;
  window.__radioIsPlaying = () => radioPlaying;
  window.__radioCurrentUrl = () => currentUrl;

  // --- Oynat ---
  async function play(url, name) {
    if (!url || !url.startsWith('http')) {
      setStatus(false, '', 'Geçersiz URL'); return;
    }

    // Cihaz modunu tespit et (play çağrılmadan ÖNCE)
    const serverMode = isServerMode();
    const deviceId = (window.Player && Player.state) ? Player.state.device : 'unknown';
    console.log(`[Radio] play() -> device: "${deviceId}", serverMode: ${serverMode}, url: ${url}`);

    // Müzik çalıyorsa durdur (player'ı durdur)
    if (window.Player && Player.stopAll) Player.stopAll();

    // Önceki radyoyu temizle (ama stopRadioServer'ı tekrar çağırma — stopAll zaten çağırdı)
    if (hls) { hls.destroy(); hls = null; }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    radioPlaying = false;

    currentUrl = url;
    currentStationName = name || url;
    setStatus(false, currentStationName, 'Bağlanıyor…');

    const streamUrl = await resolveStream(url);
    const vol = loadSavedVol();

    if (serverMode) {
      // ===== SUNUCU MODU: mpg123 ile URL'i çal =====
      console.log(`[Radio] Sunucu modunda çalınacak: ${streamUrl}, vol: ${vol}`);
      try {
        const result = await API.playRadioServer(streamUrl, vol);
        console.log('[Radio] playRadioServer sonuç:', result);
        setStatus(true, currentStationName, 'Canlı Yayın (Sunucu)');
        radioPlaying = true;
      } catch(e) {
        console.error('[Radio] playRadioServer hata:', e);
        setStatus(false, currentStationName, 'Sunucu bağlantı hatası');
      }
    } else {
      // ===== TARAYICI MODU: <audio> elementi =====
      console.log(`[Radio] Tarayıcı modunda çalınacak: ${streamUrl}, vol: ${vol}`);
      if (streamUrl.includes('.m3u8')) {
        if (!window.Hls) {
          setStatus(false, currentStationName, 'HLS yükleniyor…');
          await loadScript('https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js');
        }
        if (window.Hls && Hls.isSupported()) {
          hls = new Hls();
          hls.loadSource(streamUrl);
          hls.attachMedia(audio);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            audio.volume = vol;
            audio.play()
              .then(() => setStatus(true, currentStationName, 'Canlı Yayın'))
              .catch(() => setStatus(false, currentStationName, 'Oynatma hatası'));
          });
          hls.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) setStatus(false, currentStationName, 'Bağlantı kesildi'); });
        } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
          audio.src = streamUrl; audio.volume = vol;
          audio.play().then(() => setStatus(true, currentStationName, 'Canlı Yayın')).catch(() => setStatus(false, currentStationName, 'Oynatma hatası'));
        }
      } else {
        audio.src = streamUrl;
        audio.volume = vol;
        audio.play()
          .then(() => setStatus(true, currentStationName, 'Canlı Yayın'))
          .catch(() => setStatus(false, currentStationName, 'Oynatma hatası — CORS veya codec sorunu'));
      }

      audio.onended  = () => setStatus(false, currentStationName, 'Yayın sona erdi');
      audio.onerror  = () => { if (radioPlaying || currentUrl) setStatus(false, currentStationName, 'Akış hatası'); };
      audio.onwaiting= () => { if (radioPlaying) { const el = document.getElementById('radio-np-status'); if (el) el.textContent = 'Tamponlanıyor…'; } };
      audio.onplaying= () => { if (currentUrl) { const el = document.getElementById('radio-np-status'); if (el) el.textContent = 'Canlı Yayın'; } };
    }
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  // --- UI bağlantıları ---
  const playBtn  = document.getElementById('radio-play-btn');
  const urlInput = document.getElementById('radio-url-input');

  if (playBtn) {
    playBtn.onclick = () => {
      if (radioPlaying) { stop(); return; }
      const url = urlInput?.value.trim();
      if (url) play(url, url);
    };
  }

  if (urlInput) {
    urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') playBtn?.click(); });
  }

  document.querySelectorAll('.radio-preset-card').forEach(card => {
    card.addEventListener('click', () => {
      const url  = card.dataset.url;
      const name = card.dataset.name;
      if (radioPlaying && currentUrl === url) { stop(); return; }
      if (urlInput) urlInput.value = url;
      play(url, name);
    });
  });
}

/* ---------------- Library ---------------- */
function initLibrary() {
  let libPage = 1;
  const libLimit = 30;
  let libSearch = '';
  let libSearchTimer = null;

  function fmtSize(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  async function load() {
    const list = document.getElementById('lib-list');
    if (!list) return;
    list.innerHTML = '<div class="lib-loading"><span class="material-symbols-rounded spin">progress_activity</span> Yükleniyor…</div>';

    try {
      const url = `/api/library?page=${libPage}&limit=${libLimit}${libSearch ? '&search=' + encodeURIComponent(libSearch) : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const data = await res.json();

      // Stats
      const countEl = document.getElementById('lib-count');
      const sizeEl  = document.getElementById('lib-size');
      if (countEl) countEl.textContent = `${data.total} parça`;
      if (sizeEl)  sizeEl.textContent  = `Toplam: ${fmtSize(data.totalSize || 0)}`;

      // Pagination
      const ind = document.getElementById('lib-page-ind');
      const prev = document.getElementById('lib-prev');
      const next = document.getElementById('lib-next');
      if (ind)  ind.textContent = `${data.current} / ${Math.max(1, data.totalPages)}`;
      if (prev) prev.disabled = data.current <= 1;
      if (next) next.disabled = data.current >= data.totalPages;

      if (!data.files.length) {
        list.innerHTML = '<div class="lib-loading"><span class="material-symbols-rounded">music_off</span>&nbsp;Henüz müzik yüklenmemiş.</div>';
        return;
      }

      list.innerHTML = '';
      data.files.forEach(file => {
        const item = document.createElement('div');
        item.className = 'lib-item';
        const ext = file.name.split('.').pop().toUpperCase();
        const displayName = file.name.replace(/-\d+\.([^.]+)$/, '.$1'); // Timestamp suffix temizle
        item.innerHTML = `
          <div class="lib-item-icon">
            <span class="material-symbols-rounded">audio_file</span>
          </div>
          <div class="lib-item-info">
            <div class="lib-item-name" title="${file.name}">${displayName}</div>
            <div class="lib-item-meta">${ext} &bull; ${fmtSize(file.size)}</div>
          </div>
          <button class="lib-delete-btn" title="Sil" data-filename="${file.name}">
            <span class="material-symbols-rounded">delete</span>
          </button>
        `;
        list.appendChild(item);
      });

      // Silme butonları
      list.querySelectorAll('.lib-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => confirmDelete(btn.dataset.filename));
      });

    } catch(e) {
      const list2 = document.getElementById('lib-list');
      if (list2) list2.innerHTML = '<div class="lib-loading">Kütüphane yüklenemedi.</div>';
    }
  }

  function confirmDelete(filename) {
    // Mevcut modali kaldır
    document.getElementById('delete-modal-overlay')?.remove();

    const displayName = filename.replace(/-\d+\.([^.]+)$/, '.$1');
    const overlay = document.createElement('div');
    overlay.className = 'delete-modal-overlay';
    overlay.id = 'delete-modal-overlay';
    overlay.innerHTML = `
      <div class="delete-modal">
        <div class="dm-icon"><span class="material-symbols-rounded">delete_forever</span></div>
        <h3>Dosyayı Sil</h3>
        <p>Bu dosyayı kalıcı olarak silmek istediğinize emin misiniz?<br><strong>${displayName}</strong></p>
        <div class="delete-modal-actions">
          <button class="btn" id="dm-cancel">Vazgeç</button>
          <button class="btn btn-danger" id="dm-confirm">
            <span class="material-symbols-rounded" style="font-size:16px">delete</span> Sil
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('dm-cancel').onclick  = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('dm-confirm').onclick = async () => {
      const confirmBtn = document.getElementById('dm-confirm');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Siliniyor…';
      try {
        const res = await fetch(`/api/music/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        overlay.remove();
        load(); // Listeyi yenile
      } catch {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px">delete</span> Sil';
        alert('Dosya silinemedi. Lütfen tekrar deneyin.');
      }
    };
  }

  // Sayfalama
  const prev = document.getElementById('lib-prev');
  const next = document.getElementById('lib-next');
  if (prev) prev.onclick = () => { if (libPage > 1) { libPage--; load(); } };
  if (next) next.onclick = () => { libPage++; load(); };

  // Arama
  const searchInput = document.getElementById('lib-search');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      clearTimeout(libSearchTimer);
      libSearchTimer = setTimeout(() => {
        libSearch = e.target.value.trim();
        libPage = 1;
        load();
      }, 350);
    });
  }

  load();
}

/* ---------------- direction switch ---------------- */
function initDirection() {
  const dir = localStorage.getItem("djk_dir") || "a";
  document.documentElement.dataset.dir = dir;
  const apply = () => {
    document.querySelectorAll(".dir-switch button").forEach((b) =>
      b.classList.toggle("on", b.dataset.dir === document.documentElement.dataset.dir));
  };
  document.querySelectorAll(".dir-switch button").forEach((b) => {
    b.onclick = () => {
      document.documentElement.dataset.dir = b.dataset.dir;
      localStorage.setItem("djk_dir", b.dataset.dir);
      apply();
      if (window.updateVisualArt) window.updateVisualArt();
    };
  });
  apply();
}

window.updateVisualArt = function() {
  const artDiv = document.querySelector(".home-visual-art.art-ph");
  if (!artDiv) return;
  
  const isPlaying = typeof Player !== 'undefined' ? Player.state.isPlaying : false;
  const dir = document.documentElement.dataset.dir; 
  
  const targetState = isPlaying ? (dir === "a" ? "vid_a" : "vid_b") : "img";
  
  if (window._currentArtState !== targetState) {
    window._currentArtState = targetState;
    if (targetState === "img") {
      artDiv.innerHTML = `<img src="/img/djkalayci_logo.jpg?v=1" style="position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover;" />`;
    } else if (targetState === "vid_a") {
      artDiv.innerHTML = `<video src="/img/gunbatimi.mp4?v=1" autoplay loop muted playsinline style="position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover; pointer-events:none;"></video>`;
    } else {
      artDiv.innerHTML = `<video src="/img/gece.mp4?v=1" autoplay loop muted playsinline style="position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover; pointer-events:none;"></video>`;
    }
  }
};

function reflectDemoBadge(isDemo) {
  const badge = document.getElementById("demo-badge");
  if (badge) badge.style.display = isDemo ? "inline-flex" : "none";
}

/* ---------------- device modal ---------------- */
/* ---------------- device modal ---------------- */
function initDeviceModal() {
  const modal = document.getElementById("device-modal");
  const open = document.getElementById("btn-output-devices");
  const close = document.getElementById("btn-close-modal");
  const btnParty = document.getElementById("btn-party");
  
  const show = () => { modal.classList.add("show"); renderDevices(); };
  if (open) open.onclick = show;
  if (close) close.onclick = () => modal.classList.remove("show");
  if (modal) modal.onclick = (e) => { if (e.target === modal) modal.classList.remove("show"); };
  
  if (btnParty) {
    btnParty.onclick = () => {
      if (window.sm) window.sm.navigate("party");
    };
  }
}

async function renderDevices() {
  const list = document.getElementById("device-list");
  const devices = await API.getDevices();
  list.innerHTML = "";
  devices.forEach((d) => {
    const active = Player.state.device === d.id;
    const card = document.createElement("div");
    card.className = "device-card" + (active ? " active" : "");
    card.innerHTML = `
      <span class="material-symbols-rounded dev-icon" style="font-size:30px">${d.icon}</span>
      <div class="dev-info"><h4>${d.name}</h4><p>${d.description}</p></div>
      ${active ? '<span class="material-symbols-rounded dev-check">check_circle</span>' : ""}`;
    card.onclick = () => {
      Player.setDevice(d.id);
      document.getElementById("device-modal").classList.remove("show");
      updateDevicePill(d);
    };
    list.appendChild(card);
  });
}

function updateDevicePill(d) {
  const pill = document.getElementById("device-pill");
  if (pill) pill.querySelector(".dp-name").textContent = d.id === "browser" ? "Tarayıcı" : "Sunucu";
}

/* ---------------- upload ---------------- */

// Global upload durumu — ekranlar arası geçişte kaybolmasın
window._uploadState = window._uploadState || {
  active: false,
  total: 0,
  completed: 0,
  progresses: [],
  failed: [],
  done: false,
  successMsg: ""
};

function initUpload() {
  const dz = document.getElementById("drop-zone");
  const input = document.getElementById("file-input");
  if (!dz || !input) return;

  // Eğer devam eden / biten bir yükleme varsa UI'yi geri yükle
  const us = window._uploadState;
  if (us.active || us.done) {
    const box = document.getElementById("upload-progress");
    const bar = document.getElementById("upload-bar");
    const pct = document.getElementById("upload-pct");
    const status = document.getElementById("upload-status");
    if (box && bar && pct && status) {
      box.style.display = "block";
      if (us.done) {
        bar.style.width = "100%";
        pct.textContent = "100%";
        bar.style.background = us.failed.length > 0 ? "var(--danger)" : "var(--success)";
        status.textContent = us.successMsg;
      } else {
        const overall = us.progresses.length
          ? us.progresses.reduce((a, b) => a + b, 0) / us.progresses.length
          : 0;
        bar.style.width = overall + "%";
        pct.textContent = Math.round(overall) + "%";
        bar.style.background = "var(--accent)";
        status.textContent = `⏳ ${us.completed} / ${us.total} dosya yükleniyor… (Arka planda devam ediyor)`;

        // Tamamlanma bekleyip UI'yi güncelle
        const poll = setInterval(() => {
          if (!window._uploadState.active) {
            clearInterval(poll);
            const b2 = document.getElementById("upload-bar");
            const p2 = document.getElementById("upload-pct");
            const s2 = document.getElementById("upload-status");
            if (b2 && p2 && s2) {
              b2.style.width = "100%";
              p2.textContent = "100%";
              b2.style.background = window._uploadState.failed.length > 0 ? "var(--danger)" : "var(--success)";
              s2.textContent = window._uploadState.successMsg;
              setTimeout(() => { const bx = document.getElementById("upload-progress"); if (bx) bx.style.display = "none"; window._uploadState.done = false; }, 3500);
            }
          } else {
            // ilerlemeyi güncelle
            const overall2 = window._uploadState.progresses.reduce((a, b) => a + b, 0) / window._uploadState.progresses.length;
            const b2 = document.getElementById("upload-bar");
            const p2 = document.getElementById("upload-pct");
            const s2 = document.getElementById("upload-status");
            if (b2) b2.style.width = overall2 + "%";
            if (p2) p2.textContent = Math.round(overall2) + "%";
            if (s2) s2.textContent = `⏳ ${window._uploadState.completed} / ${window._uploadState.total} dosya yükleniyor…`;
          }
        }, 300);
      }
    }
  }

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ["dragenter", "dragover", "dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, stop));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, () => dz.classList.add("dragover")));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove("dragover")));
  dz.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
  input.addEventListener("change", (e) => handleFiles(e.target.files));

  function handleFiles(files) {
    if (!files || !files.length) return;

    // Eğer önceki yükleme tıkandıysa state'i sıfırla, yeni yüklemeye izin ver
    if (window._uploadState.active) {
      window._uploadState.active = false;
    }

    const box = document.getElementById("upload-progress");
    const bar = document.getElementById("upload-bar");
    const pct = document.getElementById("upload-pct");
    const status = document.getElementById("upload-status");
    box.style.display = "block";
    bar.style.width = "0%"; bar.style.background = "var(--accent)";
    pct.textContent = "0%";
    status.textContent = `${files.length} dosya yükleniyor…`;

    if (API.isDemo) {
      let p = 0;
      const t = setInterval(() => {
        p += 8 + Math.random() * 14;
        if (p >= 100) { p = 100; clearInterval(t); status.textContent = `${files.length} dosya yüklendi (demo).`; bar.style.background = "var(--success)"; input.value = ""; setTimeout(() => box.style.display = "none", 2600); }
        bar.style.width = p + "%"; pct.textContent = Math.round(p) + "%";
      }, 180);
      return;
    }

    // Global state'i başlat
    const us = window._uploadState;
    us.active = true;
    us.done = false;
    us.total = files.length;
    us.completed = 0;
    us.failed = [];
    us.progresses = new Array(files.length).fill(0);
    us.successMsg = "";

    function updateOverall() {
      const total = us.progresses.reduce((a, b) => a + b, 0) / us.progresses.length;
      const bar2 = document.getElementById("upload-bar");
      const pct2 = document.getElementById("upload-pct");
      const st2 = document.getElementById("upload-status");
      if (bar2) { bar2.style.width = total + "%"; }
      if (pct2) { pct2.textContent = Math.round(total) + "%"; }
      if (st2) { st2.textContent = `${us.completed} / ${us.total} dosya yüklendi…`; }
    }

    async function uploadOne(file, index) {
      const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB — proxy limitinin çok altında
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const fileId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);

      try {
        for (let ci = 0; ci < totalChunks; ci++) {
          const start = ci * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);

          const res = await fetch('/api/upload/chunk', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Chunk-Index': ci,
              'X-Total-Chunks': totalChunks,
              'X-Filename': encodeURIComponent(file.name),
              'X-File-Id': fileId
            },
            body: chunk
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            us.completed++;
            updateOverall();
            return { ok: false, name: file.name, reason: res.status === 413 ? '413' : 'err' };
          }

          // İlerlemeyi güncelle (parça bazlı)
          us.progresses[index] = ((ci + 1) / totalChunks) * 100;
          updateOverall();
        }

        us.completed++;
        us.progresses[index] = 100;
        updateOverall();
        return { ok: true, name: file.name };

      } catch (err) {
        us.completed++;
        updateOverall();
        return { ok: false, name: file.name };
      }
    }

    const CONCURRENCY = 3;
    const fileArr = Array.from(files);
    let cursor = 0;
    const results = [];

    function next() {
      if (cursor >= fileArr.length) return Promise.resolve();
      const i = cursor++;
      return uploadOne(fileArr[i], i).then(res => {
        results.push(res);
        return next();
      });
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, fileArr.length) }, next);

    Promise.all(workers).then(() => {
      const failed = results.filter(r => !r.ok);
      const has413 = results.some(r => r.reason === '413');
      us.active = false;
      us.done = true;
      us.failed = failed;

      let msg;
      if (failed.length === 0) {
        msg = `${files.length} dosya başarıyla yüklendi! ✓`;
      } else if (has413) {
        msg = `⚠️ Dosya çok büyük! Coolify → Uygulama → Advanced → Custom Labels alanına proxy limit ekleyin.`;
      } else {
        msg = `${failed.length} dosya hata verdi: ${failed.map(r => r.name).join(", ")}`;
      }
      us.successMsg = msg;

      const bar3 = document.getElementById("upload-bar");
      const pct3 = document.getElementById("upload-pct");
      const st3 = document.getElementById("upload-status");
      const bx3 = document.getElementById("upload-progress");
      if (bar3) { bar3.style.width = "100%"; bar3.style.background = failed.length ? "var(--danger)" : "var(--success)"; }
      if (pct3) pct3.textContent = "100%";
      if (st3) st3.textContent = msg;
      if (input) input.value = "";
      setTimeout(() => {
        if (bx3) bx3.style.display = "none";
        us.done = false;
      }, 3500);
    });
  }
}

/* ---------------- settings: directory browser ---------------- */
let browsePath = "";
async function initDirectoryBrowser() {
  const data = await API.getUploadPath();
  if (data.uploadPath) { browsePath = data.uploadPath; setPathUI(browsePath, true); }
  fetchDirs(browsePath);

  const up = document.getElementById("btn-up-dir");
  if (up) up.onclick = () => fetchDirs(browsePath + "/..");
  const saveBtn = document.getElementById("btn-save-path");
  if (saveBtn) saveBtn.onclick = async () => {
    const res = await API.setUploadPath(browsePath);
    if (res.success) setPathUI(res.uploadPath, true);
    else alert("Hata: " + res.error);
  };
}
async function fetchDirs(target) {
  const data = await API.getDirectories(target);
  browsePath = data.currentPath;
  setPathUI(browsePath, false);
  const list = document.getElementById("dir-list");
  if (!list) return;
  if (!data.directories.length) {
    list.innerHTML = `<div class="empty-state" style="padding:20px">Klasör boş veya erişilemiyor.</div>`;
    return;
  }
  list.innerHTML = "";
  data.directories.forEach((dir) => {
    const item = document.createElement("div");
    item.className = "dir-item";
    item.innerHTML = `<span class="material-symbols-rounded">folder</span><span>${dir}</span>`;
    item.onclick = () => fetchDirs(browsePath + "/" + dir);
    list.appendChild(item);
  });
}
function setPathUI(path, ok) {
  const input = document.getElementById("current-path");
  const icon = document.getElementById("path-ok");
  if (!input) return;
  input.value = path;
  if (ok) { input.classList.add("input-success"); if (icon) icon.style.opacity = "1"; }
  else { input.classList.remove("input-success"); if (icon) icon.style.opacity = "0"; }
}

/* ======== Sidebar Volume Control ======== */
function initSidebarVolume() {
  const track  = document.getElementById('sidebar-vol-track');
  const fill   = document.getElementById('sidebar-vol-fill');
  const handle = document.getElementById('sidebar-vol-handle');
  const pct    = document.getElementById('sidebar-vol-pct');
  const muteBtn= document.getElementById('sidebar-mute');
  const muteIcn= document.getElementById('sidebar-mute-icon');
  if (!track || !fill || !handle) return;

  // Player state'ten oku
  function getVol()   { return (window.Player && Player.state) ? Player.state.volume : 0.7; }
  function getMuted() { return (window.Player && Player.state) ? Player.state.muted : false; }

  function render() {
    const v = getMuted() ? 0 : getVol();
    const p = Math.round(v * 100);
    fill.style.width = p + '%';
    handle.style.left = p + '%';
    if (pct) pct.textContent = p + '%';
    if (muteIcn) {
      muteIcn.textContent = getMuted() ? 'volume_off' : (getVol() < 0.01 ? 'volume_mute' : getVol() < 0.5 ? 'volume_down' : 'volume_up');
    }
  }

  let _sidebarVolTimer = null;
  function setVol(v) {
    v = Math.max(0, Math.min(1, v));
    if (window.Player && Player.state) {
      Player.state.volume = v;
      Player.state.muted = false;
      // localStorage'a kaydet
      if (Player.save) Player.save();
    }
    // Browser audio - anlık güncelle
    const audio = document.getElementById('audio-player');
    if (audio) audio.volume = v;
    // Server volume - debounce ile gönder (drag sırasında spam önle)
    if (window.Player && Player.state && Player.state.device !== 'browser') {
      clearTimeout(_sidebarVolTimer);
      _sidebarVolTimer = setTimeout(() => API.volumeServer(v), 150);
    }
    render();
    // Player'daki volume bar'ları da güncelle
    syncPlayerVBars(v);
  }

  function syncPlayerVBars(v) {
    const p = Math.round(v * 100) + '%';
    document.querySelectorAll('#vbar-fill').forEach(el => el.style.width = p);
    document.querySelectorAll('#vbar-handle').forEach(el => el.style.left = p);
    const mi = document.getElementById('mute-icon');
    if (mi) mi.textContent = v < 0.01 ? 'volume_mute' : v < 0.5 ? 'volume_down' : 'volume_up';
  }

  // Drag
  let dragging = false;
  function volFromEvent(e) {
    const rect = track.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  track.addEventListener('mousedown', (e) => { dragging = true; setVol(volFromEvent(e)); });
  track.addEventListener('touchstart', (e) => { e.preventDefault(); dragging = true; setVol(volFromEvent(e)); }, { passive: false });
  window.addEventListener('mousemove', (e) => { if (dragging) setVol(volFromEvent(e)); });
  window.addEventListener('touchmove', (e) => { if (dragging) setVol(volFromEvent(e)); }, { passive: true });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('touchend', () => { dragging = false; });

  // Mute toggle
  if (muteBtn) muteBtn.addEventListener('click', () => {
    if (window.Player && Player.state) {
      Player.state.muted = !Player.state.muted;
      const v = Player.state.muted ? 0 : Player.state.volume;
      const audio = document.getElementById('audio-player');
      if (audio) audio.volume = v;
      if (Player.state.device !== 'browser') {
        API.volumeServer(Player.state.muted ? 0 : Player.state.volume);
      }
    }
    render();
  });

  // Periyodik senkronizasyon (player'dan değişiklik olursa)
  setInterval(render, 500);
  render();
}
