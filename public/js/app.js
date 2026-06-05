/* =========================================================
   app.js — Uygulama kabuğu: navigasyon, yükleme, ayarlar,
   cihaz modalı, yön (A/B) anahtarı, başlatma.
   ========================================================= */

const SCREEN_TITLES = { home: "Ana Sayfa", upload: "Müzik Yükle", player: "Oynatıcı", settings: "Ayarlar" };

document.addEventListener("DOMContentLoaded", async () => {
  initDirection();

  const sm = new ScreenManager("main-content");
  window.sm = sm;

  const nav = document.querySelectorAll(".nav-links li[data-target]");
  nav.forEach((li) => li.addEventListener("click", () => {
    nav.forEach((n) => n.classList.remove("active"));
    li.classList.add("active");
    sm.navigate(li.dataset.target);
  }));

  window.addEventListener("screenChanged", (e) => {
    const s = e.detail.screen;
    const t = document.getElementById("topbar-title");
    if (t) t.textContent = SCREEN_TITLES[s] || "";
    if (s === "settings") initDirectoryBrowser();
    if (s === "upload") initUpload();
    if (s === "player" || s === "party") Player.init();
    if (s === "home") {
      window._currentArtState = "";
      if (window.updateVisualArt) window.updateVisualArt();
    }
  });

  sm.navigate("home");
  initDeviceModal();

  // backend tespiti arka planda — ana sayfayı bloklamasın
  await API.init();
  reflectDemoBadge(API.isDemo);
});

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
