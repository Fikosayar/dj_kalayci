/* =========================================================
   app.js — Uygulama kabuğu: navigasyon, yükleme, ayarlar,
   cihaz modalı, yön (A/B) anahtarı, başlatma.
   ========================================================= */

const SCREEN_TITLES = { home: "Ana Sayfa", upload: "Müzik Yükle", player: "Oynatıcı", settings: "Ayarlar" };

document.addEventListener("DOMContentLoaded", async () => {
  initDirection();

  const sm = new ScreenManager("main-content");

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
    if (s === "player") Player.init();
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
      artDiv.innerHTML = `<img src="/img/djkalayci_logo.jpg" style="width:100%; height:100%; object-fit:cover;" />`;
    } else if (targetState === "vid_a") {
      artDiv.innerHTML = `<video src="/img/gunbatimi.mp4" autoplay loop muted playsinline style="width:100%; height:100%; object-fit:cover; pointer-events:none;"></video>`;
    } else {
      artDiv.innerHTML = `<video src="/img/gece.mp4" autoplay loop muted playsinline style="width:100%; height:100%; object-fit:cover; pointer-events:none;"></video>`;
    }
  }
};

function reflectDemoBadge(isDemo) {
  const badge = document.getElementById("demo-badge");
  if (badge) badge.style.display = isDemo ? "inline-flex" : "none";
}

/* ---------------- device modal ---------------- */
function initDeviceModal() {
  const modal = document.getElementById("device-modal");
  const open = document.getElementById("btn-output-devices");
  const pill = document.getElementById("device-pill");
  const close = document.getElementById("btn-close-modal");
  const show = () => { modal.classList.add("show"); renderDevices(); };
  if (open) open.onclick = show;
  if (pill) pill.onclick = show;
  if (close) close.onclick = () => modal.classList.remove("show");
  if (modal) modal.onclick = (e) => { if (e.target === modal) modal.classList.remove("show"); };
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
function initUpload() {
  const dz = document.getElementById("drop-zone");
  const input = document.getElementById("file-input");
  if (!dz || !input) return;

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ["dragenter", "dragover", "dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, stop));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, () => dz.classList.add("dragover")));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove("dragover")));
  dz.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
  input.addEventListener("change", (e) => handleFiles(e.target.files));

  function handleFiles(files) {
    if (!files || !files.length) return;
    const box = document.getElementById("upload-progress");
    const bar = document.getElementById("upload-bar");
    const pct = document.getElementById("upload-pct");
    const status = document.getElementById("upload-status");
    box.style.display = "block";
    bar.style.width = "0%"; bar.style.background = "var(--accent)";
    pct.textContent = "0%";
    status.textContent = `${files.length} dosya yükleniyor…`;

    if (API.isDemo) { // simüle
      let p = 0;
      const t = setInterval(() => {
        p += 8 + Math.random() * 14;
        if (p >= 100) { p = 100; clearInterval(t); status.textContent = `${files.length} dosya yüklendi (demo).`; bar.style.background = "var(--success)"; input.value = ""; setTimeout(() => box.style.display = "none", 2600); }
        bar.style.width = p + "%"; pct.textContent = Math.round(p) + "%";
      }, 180);
      return;
    }

    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload", true);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = (e.loaded / e.total) * 100;
      bar.style.width = p + "%"; pct.textContent = Math.round(p) + "%";
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        status.textContent = JSON.parse(xhr.responseText).message;
        bar.style.background = "var(--success)"; input.value = "";
        setTimeout(() => { box.style.display = "none"; }, 3000);
      } else { status.textContent = "Hata!"; bar.style.background = "var(--danger)"; }
    };
    xhr.onerror = () => { status.textContent = "Ağ Hatası!"; bar.style.background = "var(--danger)"; };
    xhr.send(fd);
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
