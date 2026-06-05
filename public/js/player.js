/* =========================================================
   player.js — Oynatıcı mantığı + dalgaform görselleştirme
   ========================================================= */

const Player = (() => {
  const WAVE_BARS = 64;
  const LS = "djk_player_v1";

  const state = {
    page: 1, limit: 25, totalPages: 1,
    playlist: [],
    current: null,
    isPlaying: false,
    isShuffle: false,
    isLoop: false,
    device: "browser",
    volume: 1,
    muted: false,
    time: 0,
    duration: 0,
  };

  // DOM refs (her ekran girişinde yenilenir)
  let el = {};
  let audio = null;
  let virtualTimer = null;
  let lastPlayedBar = -1;
  let windowBound = false;

  // ---- persistence ----
  function save() {
    try {
      localStorage.setItem(LS, JSON.stringify({
        current: state.current, time: state.time, page: state.page,
        limit: state.limit, volume: state.volume, muted: state.muted,
        isShuffle: state.isShuffle, isLoop: state.isLoop, device: state.device,
      }));
    } catch (e) {}
  }
  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem(LS) || "{}");
      Object.assign(state, {
        limit: s.limit || 25, page: s.page || 1,
        volume: s.volume ?? 1, muted: !!s.muted,
        isShuffle: !!s.isShuffle, isLoop: !!s.isLoop,
        device: s.device || "browser",
      });
      state._restoreTrack = s.current; state._restoreTime = s.time || 0;
    } catch (e) {}
  }

  const fmt = (s) => {
    if (isNaN(s) || s == null) return "00:00";
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };

  const hasRealAudio = () => !API.isDemo && state.device === "browser";

  // ---------------- init ----------------
  let restored = false;
  function init() {
    if (!restored) { restore(); restored = true; }
    el = {
      audio: document.getElementById("audio-player"),
      cover: document.getElementById("cover-art-img"),
      coverPh: document.getElementById("cover-ph"),
      title: document.getElementById("track-title"),
      sub: document.getElementById("track-sub"),
      wave: document.getElementById("wave"),
      tCur: document.getElementById("time-current"),
      tTot: document.getElementById("time-total"),
      play: document.getElementById("btn-play"),
      playIcon: document.getElementById("play-icon"),
      next: document.getElementById("btn-next"),
      prev: document.getElementById("btn-prev"),
      shuffle: document.getElementById("btn-shuffle"),
      loop: document.getElementById("btn-loop"),
      mute: document.getElementById("btn-mute"),
      muteIcon: document.getElementById("mute-icon"),
      vbar: document.getElementById("vbar"),
      vfill: document.getElementById("vbar-fill"),
      vhandle: document.getElementById("vbar-handle"),
      list: document.getElementById("music-list"),
      limit: document.getElementById("limit-select"),
      prevPage: document.getElementById("btn-prev-page"),
      nextPage: document.getElementById("btn-next-page"),
      pageInd: document.getElementById("page-indicator"),
    };
    audio = el.audio;

    buildWave();

    if (el.limit) {
      el.limit.value = state.limit;
      el.limit.onchange = (e) => { state.limit = parseInt(e.target.value); state.page = 1; save(); loadList(); };
    }
    if (el.prevPage) el.prevPage.onclick = () => { if (state.page > 1) { state.page--; save(); loadList(); } };
    if (el.nextPage) el.nextPage.onclick = () => { if (state.page < state.totalPages) { state.page++; save(); loadList(); } };

    bindControls();
    syncToggleButtons();
    applyVolume();
    loadList().then(restorePlayingUI);
  }

  // ---------------- list ----------------
  async function loadList() {
    if (!el.list) return;
    el.list.innerHTML = `<div class="empty-state">Yükleniyor…</div>`;
    const data = await API.getMusic(state.page, state.limit);
    state.totalPages = data.totalPages;
    state.playlist = data.files;

    if (el.pageInd) el.pageInd.textContent = `${data.current} / ${Math.max(1, data.totalPages)}`;
    if (el.prevPage) el.prevPage.disabled = data.current <= 1;
    if (el.nextPage) el.nextPage.disabled = data.current >= data.totalPages;

    el.list.innerHTML = "";
    if (!data.files.length) {
      el.list.innerHTML = `<div class="empty-state"><span class="material-symbols-rounded">music_off</span>Henüz müzik yüklenmemiş.</div>`;
      return;
    }
    data.files.forEach((file, i) => {
      const idx = (state.page - 1) * state.limit + i + 1;
      const row = document.createElement("div");
      row.className = "track-row" + (state.current === file ? " playing" : "");
      row.innerHTML = `
        <span class="track-idx">${String(idx).padStart(2, "0")}</span>
        <span class="play-ind"><i style="height:8px"></i><i style="height:13px"></i><i style="height:6px"></i></span>
        <span class="track-title" title="${cleanName(file)}">${cleanName(file)}</span>
        <span class="track-dur">${fmt(API.durationFor(file))}</span>
        <span class="hover-play material-symbols-rounded">play_arrow</span>`;
      row.onclick = () => playMusic(file);
      el.list.appendChild(row);
    });
  }

  function cleanName(f) {
    return f.replace(/\.(mp3|wav)$/i, "").replace(/-\d{10,}$/, "").replace(/_/g, " ").trim();
  }

  function restorePlayingUI() {
    if (state._restoreTrack && state.playlist.includes(state._restoreTrack)) {
      loadTrackMeta(state._restoreTrack);
      state.current = state._restoreTrack;
      state.time = state._restoreTime || 0;
      state.duration = API.durationFor(state.current);
      markRow();
      updateWaveProgress();
      el.tCur.textContent = fmt(state.time);
      el.tTot.textContent = fmt(state.duration);
      showMini();
    }
    state._restoreTrack = null;
  }

  // ---------------- waveform ----------------
  function buildWave() {
    if (!el.wave) return;
    el.wave.innerHTML = "";
    for (let i = 0; i < WAVE_BARS; i++) {
      const b = document.createElement("div");
      b.className = "wave-bar";
      b.style.height = "20%";
      el.wave.appendChild(b);
    }
    el.wave.onclick = (e) => {
      if (!state.current) return;
      const rect = el.wave.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      seekTo(p);
    };
  }
  function drawWavePeaks(name) {
    if (!el.wave) return;
    const peaks = API.peaksFor(name, WAVE_BARS);
    [...el.wave.children].forEach((bar, i) => { bar.style.height = `${Math.round(peaks[i] * 100)}%`; });
    lastPlayedBar = -1;
    updateWaveProgress();
  }
  function updateWaveProgress() {
    if (!el.wave || !el.wave.children.length) return;
    const p = state.duration ? state.time / state.duration : 0;
    const upto = Math.round(p * WAVE_BARS);
    if (upto === lastPlayedBar) return;
    [...el.wave.children].forEach((bar, i) => bar.classList.toggle("played", i < upto));
    lastPlayedBar = upto;
  }

  // ---------------- play control ----------------
  function loadTrackMeta(filename) {
    el.title.textContent = cleanName(filename);
    el.sub.textContent = API.isDemo ? "DEMO · DJ_Kalayci" : "DJ_Kalayci";
    drawWavePeaks(filename);
    // cover
    el.cover.classList.remove("show");
    const coverUrl = API.coverURL(filename);
    if (coverUrl) {
      fetch(coverUrl)
        .then(r => { if (!r.ok) throw 0; return r.blob(); })
        .then(b => { el.cover.src = URL.createObjectURL(b); el.cover.classList.add("show"); })
        .catch(() => { el.cover.classList.remove("show"); el.cover.removeAttribute("src"); });
    }
  }

  function playMusic(filename) {
    state.current = filename;
    state.duration = API.durationFor(filename);
    state.time = 0;
    loadTrackMeta(filename);
    markRow();
    showMini();

    if (hasRealAudio()) {
      API.stopServer();
      audio.src = API.streamURL(filename);
      audio.volume = state.muted ? 0 : state.volume;
      audio.play().then(() => { state.isPlaying = true; setPlayIcon(); }).catch(() => {});
      stopVirtual();
    } else {
      if (audio) audio.pause();
      if (state.device !== "browser") API.playServer(filename);
      state.isPlaying = true;
      setPlayIcon();
      startVirtual();
    }
    save();
  }

  function togglePlay() {
    if (!state.current) {
      if (state.playlist.length) playMusic(state.playlist[0]);
      return;
    }
    if (hasRealAudio()) {
      audio.paused ? audio.play().catch(()=>{}) : audio.pause();
    } else {
      if (state.device !== "browser") API.pauseServer();
      state.isPlaying = !state.isPlaying;
      state.isPlaying ? startVirtual() : stopVirtual();
      setPlayIcon();
    }
  }

  function seekTo(p) {
    if (hasRealAudio() && audio.duration) {
      audio.currentTime = p * audio.duration;
    } else {
      state.time = p * state.duration;
      if (state.device !== "browser") API.seekServer(p * 100);
      updateWaveProgress();
      el.tCur.textContent = fmt(state.time);
    }
    save();
  }

  // virtual clock (demo + sunucu modu)
  function startVirtual() {
    stopVirtual();
    let last = performance.now();
    virtualTimer = setInterval(async () => {
      if (state.device === "debian_alsa") {
        try {
          const s = await API.statusServer();
          if (s) {
            state.time = s.time;
            if (s.duration) state.duration = s.duration;
          }
        } catch(e){}
      } else {
        const now = performance.now();
        state.time += (now - last) / 1000; last = now;
      }
      if (state.duration > 0 && state.time >= state.duration) { state.time = state.duration; onEnded(); return; }
      el.tCur.textContent = fmt(state.time);
      el.tTot.textContent = fmt(state.duration);
      updateWaveProgress();
      if (Math.floor(state.time) % 3 === 0) save();
    }, state.device === "debian_alsa" ? 1000 : 250);
  }
  function stopVirtual() { if (virtualTimer) { clearInterval(virtualTimer); virtualTimer = null; } }

  function onEnded() {
    stopVirtual();
    if (state.isLoop) { state.time = 0; if (hasRealAudio()) { audio.currentTime = 0; audio.play().catch(()=>{}); } else startVirtual(); }
    else next();
  }

  function getAdjacent(dir) {
    if (!state.playlist.length) return null;
    if (state.isShuffle && dir === 1) return state.playlist[Math.floor(Math.random() * state.playlist.length)];
    let i = state.playlist.indexOf(state.current);
    if (i === -1) i = 0;
    else { i += dir; if (i >= state.playlist.length) i = 0; if (i < 0) i = state.playlist.length - 1; }
    return state.playlist[i];
  }
  function next() { const f = getAdjacent(1); if (f) playMusic(f); }
  function prev() { const f = getAdjacent(-1); if (f) playMusic(f); }

  // ---------------- UI sync ----------------
  function setPlayIcon() {
    if (el.playIcon) el.playIcon.textContent = state.isPlaying ? "pause" : "play_arrow";
    updateMini();
    if (window.updateVisualArt) window.updateVisualArt();
  }
  function markRow() {
    document.querySelectorAll(".track-row").forEach((row) => {
      const t = row.querySelector(".track-title");
      row.classList.toggle("playing", t && t.textContent === cleanName(state.current));
    });
  }
  function syncToggleButtons() {
    if (el.shuffle) el.shuffle.classList.toggle("active", state.isShuffle);
    if (el.loop) el.loop.classList.toggle("active", state.isLoop);
  }
  function applyVolume() {
    const v = state.muted ? 0 : state.volume;
    if (el.vfill) el.vfill.style.width = `${v * 100}%`;
    if (el.vhandle) el.vhandle.style.left = `${v * 100}%`;
    if (el.muteIcon) el.muteIcon.textContent = v === 0 ? "volume_off" : v < 0.5 ? "volume_down" : "volume_up";
    if (audio) audio.volume = v;
    if (state.device !== "browser") API.volumeServer(state.muted ? 0 : Math.pow(state.volume, 3));
  }

  // sidebar mini now-playing
  function showMini() {
    const mini = document.getElementById("np-mini");
    if (!mini || !state.current) return;
    mini.classList.add("show");
    updateMini();
  }
  function updateMini() {
    const mini = document.getElementById("np-mini");
    if (!mini || !state.current) return;
    const b = mini.querySelector(".np-mini-info b");
    const eq = mini.querySelector(".eq");
    if (b) b.textContent = cleanName(state.current);
    if (eq) eq.style.visibility = state.isPlaying ? "visible" : "hidden";
  }

  // ---------------- bindings ----------------
  function bindControls() {
    el.play.onclick = togglePlay;
    el.next.onclick = next;
    el.prev.onclick = prev;
    el.shuffle.onclick = () => { state.isShuffle = !state.isShuffle; syncToggleButtons(); save(); };
    el.loop.onclick = () => { state.isLoop = !state.isLoop; syncToggleButtons(); save(); };
    el.mute.onclick = () => { state.muted = !state.muted; applyVolume(); save(); };

    // real audio events
    if (audio) {
      audio.onplay = () => { state.isPlaying = true; setPlayIcon(); };
      audio.onpause = () => { state.isPlaying = false; setPlayIcon(); };
      audio.onended = onEnded;
      audio.ontimeupdate = () => {
        if (!hasRealAudio()) return;
        state.time = audio.currentTime;
        state.duration = audio.duration || state.duration;
        el.tCur.textContent = fmt(state.time);
        el.tTot.textContent = fmt(state.duration);
        updateWaveProgress();
      };
    }

    // volume drag — el.vbar her ekran girişinde yenilenir, setVol global tutulur
    window.__djkSetVol = (e) => {
      const bar = document.getElementById("vbar");
      if (!bar) return;
      const r = bar.getBoundingClientRect();
      let p = (e.clientX - r.left) / r.width; p = Math.min(1, Math.max(0, p));
      state.volume = p; if (p > 0) state.muted = false; applyVolume(); save();
    };
    el.vbar.addEventListener("mousedown", (e) => { window.__djkVDrag = true; window.__djkSetVol(e); });

    if (!windowBound) {
      window.addEventListener("mousemove", (e) => { if (window.__djkVDrag) window.__djkSetVol(e); });
      window.addEventListener("mouseup", () => { window.__djkVDrag = false; });
      windowBound = true;
    }
  }

  // cihaz değişimi (app.js modal'dan çağırır)
  function setDevice(id) {
    const wasPlaying = state.isPlaying;
    state.device = id; save();
    if (!state.current) return;
    if (id === "browser") {
      API.stopServer();
      if (hasRealAudio()) {
        stopVirtual();
        audio.src = API.streamURL(state.current);
        audio.currentTime = state.time || 0;
        if (wasPlaying) audio.play().catch(()=>{});
      } else { // demo browser → virtual
        if (wasPlaying) startVirtual();
      }
    } else {
      if (audio) audio.pause();
      stopVirtual();
      if (wasPlaying) { API.playServer(state.current); state.isPlaying = true; startVirtual(); }
    }
    setPlayIcon();
  }

  return { init, playMusic, setDevice, state };
})();
