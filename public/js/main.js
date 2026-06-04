document.addEventListener('DOMContentLoaded', () => {
    const screenManager = new ScreenManager('main-content');
    screenManager.navigate('home');

    const navItems = document.querySelectorAll('.nav-links li[data-target]');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            const targetScreen = e.currentTarget.getAttribute('data-target');
            if (targetScreen) {
                navItems.forEach(nav => nav.classList.remove('active'));
                e.currentTarget.classList.add('active');
                screenManager.navigate(targetScreen);
            }
        });
    });

    window.addEventListener('screenChanged', (e) => {
        const screen = e.detail.screen;
        if (screen === 'settings') initDirectoryBrowser();
        if (screen === 'upload') initUploadLogic();
        if (screen === 'player') initPlayerLogic();
    });

    initDeviceModal();
});

// --- SETTINGS: DIRECTORY BROWSER ---
let currentBrowsePath = ''; 
function initDirectoryBrowser() {
    fetch('/api/settings/upload-path')
        .then(res => res.json())
        .then(data => {
            if (data.uploadPath) {
                currentBrowsePath = data.uploadPath;
                updatePathUI(currentBrowsePath, true);
            }
            fetchDirectories(currentBrowsePath);
        })
        .catch(err => console.error(err));

    const btnUp = document.getElementById('btn-up-dir');
    if (btnUp) btnUp.onclick = () => fetchDirectories(currentBrowsePath + '/..');
    
    const saveBtn = document.getElementById('save-location-btn');
    if (saveBtn) {
        saveBtn.onclick = () => {
            fetch('/api/settings/upload-path', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadPath: currentBrowsePath })
            }).then(res => res.json()).then(data => {
                if (data.success) updatePathUI(data.uploadPath, true);
                else alert('Hata: ' + data.error);
            });
        };
    }
}
function fetchDirectories(targetPath) {
    const url = targetPath ? `/api/directories?path=${encodeURIComponent(targetPath)}` : `/api/directories`;
    fetch(url).then(res => res.json()).then(data => {
        currentBrowsePath = data.currentPath;
        updatePathUI(currentBrowsePath, false);
        const dirList = document.getElementById('dir-list');
        if (dirList) {
            dirList.innerHTML = data.directories.length === 0 ? 
                '<div style="padding: 12px; color: var(--text-secondary); text-align: center;">Klasör boş veya erişilemiyor.</div>' : '';
            data.directories.forEach(dir => {
                const div = document.createElement('div');
                div.style.padding = '8px 12px'; div.style.cursor = 'pointer'; div.style.borderRadius = '6px';
                div.style.display = 'flex'; div.style.alignItems = 'center'; div.style.gap = '12px';
                div.innerHTML = `<span class="material-symbols-rounded" style="color: #fbbf24;">folder</span> <span>${dir}</span>`;
                div.onmouseover = () => div.style.background = 'rgba(255,255,255,0.1)';
                div.onmouseout = () => div.style.background = 'transparent';
                div.onclick = () => fetchDirectories(currentBrowsePath + '/' + dir);
                dirList.appendChild(div);
            });
        }
    });
}
function updatePathUI(path, isSuccess) {
    const input = document.getElementById('current-path-input');
    const icon = document.getElementById('path-success-icon');
    if (input) {
        input.value = path;
        if (isSuccess) { input.classList.add('input-success'); if(icon) icon.style.opacity = '1'; }
        else { input.classList.remove('input-success'); if(icon) icon.style.opacity = '0'; }
    }
}

// --- OUTPUT DEVICE MODAL LOGIC ---
function initDeviceModal() {
    const btnOpen = document.getElementById('btn-output-devices');
    const modal = document.getElementById('device-modal');
    const btnClose = document.getElementById('btn-close-modal');
    
    if (btnOpen) btnOpen.onclick = () => {
        modal.style.display = 'flex';
        fetchDevices();
    };
    if (btnClose) btnClose.onclick = () => {
        modal.style.display = 'none';
    };
    if (modal) modal.onclick = (e) => {
        if (e.target === modal) modal.style.display = 'none';
    };
}

function fetchDevices() {
    fetch('/api/devices')
        .then(res => res.json())
        .then(devices => {
            const list = document.getElementById('device-list');
            list.innerHTML = '';
            devices.forEach(device => {
                const isActive = playerState.outputDevice === device.id;
                const card = document.createElement('div');
                card.className = `device-card ${isActive ? 'active' : ''}`;
                card.innerHTML = `
                    <span class="material-symbols-rounded" style="font-size: 32px; color: ${isActive ? 'var(--accent-color)' : 'var(--text-secondary)'}">${device.icon}</span>
                    <div style="flex: 1;">
                        <h4 style="margin: 0; font-size: 16px;">${device.name}</h4>
                        <p style="margin: 4px 0 0; font-size: 13px; color: var(--text-secondary);">${device.description}</p>
                    </div>
                    ${isActive ? '<span class="material-symbols-rounded" style="color: var(--success);">check_circle</span>' : ''}
                `;
                card.onclick = () => selectDevice(device.id);
                list.appendChild(card);
            });
        });
}

function selectDevice(deviceId) {
    playerState.outputDevice = deviceId;
    const modal = document.getElementById('device-modal');
    if (modal) modal.style.display = 'none';
    
    if (playerState.currentPlaying) {
        if (deviceId === 'browser') {
            fetch('/api/music/stop-server', { method: 'POST' });
            if (audio) {
                audio.src = `/api/music/play/${encodeURIComponent(playerState.currentPlaying)}`;
                audio.play();
            }
        } else {
            if (audio) audio.pause();
            fetch('/api/music/play-server', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: playerState.currentPlaying })
            });
            playerState.isPlaying = true;
            if (playPauseIcon) playPauseIcon.innerText = 'pause';
        }
    }
}


// --- UPLOAD LOGIC ---
function initUploadLogic() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    if (!dropZone || !fileInput) return;
    const preventDefaults = e => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, preventDefaults));
    ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, () => dropZone.classList.add('dragover')));
    ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, () => dropZone.classList.remove('dragover')));
    dropZone.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
    fileInput.addEventListener('change', e => handleFiles(e.target.files));

    function handleFiles(files) {
        if (!files || files.length === 0) return;
        const progressContainer = document.getElementById('upload-progress-container');
        const progressBar = document.getElementById('upload-progress-bar');
        const percentText = document.getElementById('upload-percent');
        const statusText = document.getElementById('upload-status-text');
        
        progressContainer.style.display = 'block';
        progressBar.style.width = '0%';
        percentText.innerText = '0%';
        statusText.innerText = 'Yükleniyor...';

        const formData = new FormData();
        for (let i = 0; i < files.length; i++) formData.append('files', files[i]);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload', true);
        xhr.upload.onprogress = e => {
            if (e.lengthComputable) {
                const percentComplete = (e.loaded / e.total) * 100;
                progressBar.style.width = percentComplete + '%';
                percentText.innerText = Math.round(percentComplete) + '%';
            }
        };
        xhr.onload = () => {
            if (xhr.status === 200) {
                statusText.innerText = JSON.parse(xhr.responseText).message;
                progressBar.style.background = 'var(--success)';
                fileInput.value = '';
                setTimeout(() => { progressContainer.style.display = 'none'; progressBar.style.background = 'var(--accent-color)'; }, 3000);
            } else { statusText.innerText = 'Hata!'; progressBar.style.background = 'var(--danger)'; }
        };
        xhr.onerror = () => { statusText.innerText = 'Ağ Hatası!'; progressBar.style.background = 'var(--danger)'; };
        xhr.send(formData);
    }
}

// --- MUSIC PLAYER LOGIC ---
let playerState = {
    page: 1, limit: 25, totalPages: 1,
    playlist: [],
    currentPlaying: null,
    isPlaying: false,
    isShuffle: false,
    isLoop: false,
    outputDevice: 'browser',
    volume: 1,
    isMuted: false
};

let audio, playPauseBtn, playPauseIcon, btnNext, btnPrev, btnShuffle, btnLoop;
let progressBarBg, progressBarFill, progressBarHandle, timeCurrent, timeTotal;
let btnMute, muteIcon, volumeBarBg, volumeBarFill, volumeBarHandle;
let coverArtImg, defaultCoverIcon, trackNameEl;

function initPlayerLogic() {
    audio = document.getElementById('audio-player');
    playPauseBtn = document.getElementById('btn-play-pause');
    playPauseIcon = document.getElementById('play-pause-icon');
    btnNext = document.getElementById('btn-next');
    btnPrev = document.getElementById('btn-prev');
    btnShuffle = document.getElementById('btn-shuffle');
    btnLoop = document.getElementById('btn-loop');
    
    progressBarBg = document.getElementById('progress-bar-bg');
    progressBarFill = document.getElementById('progress-bar-fill');
    progressBarHandle = document.getElementById('progress-bar-handle');
    timeCurrent = document.getElementById('time-current');
    timeTotal = document.getElementById('time-total');
    
    // YENİ: Ses kontrolleri
    btnMute = document.getElementById('btn-mute');
    muteIcon = document.getElementById('mute-icon');
    volumeBarBg = document.getElementById('volume-bar-bg');
    volumeBarFill = document.getElementById('volume-bar-fill');
    volumeBarHandle = document.getElementById('volume-bar-handle');

    coverArtImg = document.getElementById('cover-art-img');
    defaultCoverIcon = document.getElementById('default-cover-icon');
    trackNameEl = document.getElementById('current-track-name');

    const limitSelect = document.getElementById('player-limit-select');
    const btnPrevPage = document.getElementById('btn-prev-page');
    const btnNextPage = document.getElementById('btn-next-page');

    if (limitSelect) {
        limitSelect.value = playerState.limit;
        limitSelect.onchange = (e) => { playerState.limit = parseInt(e.target.value); playerState.page = 1; loadMusicList(); };
    }
    if (btnPrevPage) btnPrevPage.onclick = () => { if (playerState.page > 1) { playerState.page--; loadMusicList(); } };
    if (btnNextPage) btnNextPage.onclick = () => { if (playerState.page < playerState.totalPages) { playerState.page++; loadMusicList(); } };

    loadMusicList();
    bindAudioEvents();
}

function loadMusicList() {
    const musicListContainer = document.getElementById('music-list');
    const indicator = document.getElementById('page-indicator');
    const btnPrevPage = document.getElementById('btn-prev-page');
    const btnNextPage = document.getElementById('btn-next-page');

    if (!musicListContainer) return;
    musicListContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 24px;">Yükleniyor...</div>';

    fetch(`/api/music?page=${playerState.page}&limit=${playerState.limit}`)
        .then(res => res.json())
        .then(data => {
            playerState.totalPages = data.totalPages;
            playerState.playlist = data.files;
            
            if (indicator) indicator.innerText = `Sayfa: ${data.current} / ${Math.max(1, data.totalPages)}`;
            if (btnPrevPage) btnPrevPage.disabled = data.current <= 1;
            if (btnNextPage) btnNextPage.disabled = data.current >= data.totalPages;

            musicListContainer.innerHTML = '';
            if (data.files.length === 0) {
                musicListContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 24px;">Henüz müzik yüklenmemiş.</div>';
                return;
            }

            data.files.forEach(file => {
                const item = document.createElement('div');
                item.className = 'music-item';
                if (playerState.currentPlaying === file) item.classList.add('playing');
                
                item.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 12px; overflow: hidden;">
                        <span class="material-symbols-rounded" style="color: ${playerState.currentPlaying === file ? 'var(--success)' : 'var(--accent-color)'};">
                            ${playerState.currentPlaying === file ? 'equalizer' : 'music_note'}
                        </span>
                        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${file}">${file}</span>
                    </div>
                    <span class="material-symbols-rounded" style="color: var(--text-secondary);">play_arrow</span>
                `;
                item.onclick = () => playMusic(file);
                musicListContainer.appendChild(item);
            });
        });
}

function formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function updateVolumeUI() {
    const effectiveVolume = playerState.isMuted ? 0 : playerState.volume;
    const percent = effectiveVolume * 100;
    
    if (volumeBarFill) volumeBarFill.style.width = `${percent}%`;
    if (volumeBarHandle) volumeBarHandle.style.left = `${percent}%`;
    
    if (muteIcon) {
        if (effectiveVolume === 0) muteIcon.innerText = 'volume_off';
        else if (effectiveVolume < 0.5) muteIcon.innerText = 'volume_down';
        else muteIcon.innerText = 'volume_up';
    }
}

function bindAudioEvents() {
    playPauseBtn.onclick = () => {
        if (!playerState.currentPlaying) {
            if (playerState.playlist.length > 0) playMusic(playerState.playlist[0]);
            return;
        }
        
        if (playerState.outputDevice === 'browser') {
            if (audio.paused) audio.play();
            else audio.pause();
        } else {
            if (playerState.isPlaying) {
                fetch('/api/music/pause-server', { method: 'POST' });
                playerState.isPlaying = false;
                playPauseIcon.innerText = 'play_arrow';
            } else {
                fetch('/api/music/play-server', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: playerState.currentPlaying })
                });
                playerState.isPlaying = true;
                playPauseIcon.innerText = 'pause';
            }
        }
    };

    audio.onplay = () => {
        playerState.isPlaying = true;
        playPauseIcon.innerText = 'pause';
    };
    audio.onpause = () => {
        playerState.isPlaying = false;
        playPauseIcon.innerText = 'play_arrow';
    };

    audio.ontimeupdate = () => {
        if (playerState.outputDevice !== 'browser') return;
        
        timeCurrent.innerText = formatTime(audio.currentTime);
        if (audio.duration) {
            timeTotal.innerText = formatTime(audio.duration);
            const percent = (audio.currentTime / audio.duration) * 100;
            progressBarFill.style.width = `${percent}%`;
            progressBarHandle.style.left = `${percent}%`;
        }
    };

    let isProgressDragging = false;
    progressBarBg.addEventListener('mousedown', (e) => {
        isProgressDragging = true;
        const rect = progressBarBg.getBoundingClientRect();
        let percent = (e.clientX - rect.left) / rect.width;
        if (percent < 0) percent = 0; if (percent > 1) percent = 1;
        
        if (playerState.outputDevice === 'browser' && audio.duration) {
            audio.currentTime = percent * audio.duration;
        } else if (playerState.outputDevice === 'debian_alsa') {
            fetch('/api/music/seek-server', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ percent: percent * 100 })
            });
            progressBarFill.style.width = `${percent * 100}%`;
            progressBarHandle.style.left = `${percent * 100}%`;
        }
    });
    window.addEventListener('mousemove', (e) => {
        if (isProgressDragging) {
            const rect = progressBarBg.getBoundingClientRect();
            let percent = (e.clientX - rect.left) / rect.width;
            if (percent < 0) percent = 0; if (percent > 1) percent = 1;
            
            if (playerState.outputDevice === 'browser' && audio.duration) {
                audio.currentTime = percent * audio.duration;
            } else if (playerState.outputDevice === 'debian_alsa') {
                progressBarFill.style.width = `${percent * 100}%`;
                progressBarHandle.style.left = `${percent * 100}%`;
            }
        }
    });
    window.addEventListener('mouseup', (e) => { 
        if (isProgressDragging && playerState.outputDevice === 'debian_alsa') {
            const rect = progressBarBg.getBoundingClientRect();
            let percent = (e.clientX - rect.left) / rect.width;
            if (percent < 0) percent = 0; if (percent > 1) percent = 1;
            fetch('/api/music/seek-server', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ percent: percent * 100 })
            });
        }
        isProgressDragging = false; 
    });
    
    // YENİ: Ses Olayları (Volume Events)
    if (audio) {
        audio.volume = Math.pow(playerState.volume, 3);
        updateVolumeUI();
        
        if (playerState.outputDevice === 'debian_alsa') {
            fetch('/api/music/volume-server', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ volume: Math.pow(playerState.volume, 3) })
            });
        }
    }

    let isVolumeDragging = false;
    if (volumeBarBg) {
        const updateVolume = (e) => {
            const rect = volumeBarBg.getBoundingClientRect();
            let percent = (e.clientX - rect.left) / rect.width;
            if (percent < 0) percent = 0;
            if (percent > 1) percent = 1;
            
            playerState.volume = percent;
            if (playerState.volume > 0) playerState.isMuted = false;
            
            const expVol = Math.pow(playerState.volume, 3);
            if (audio) audio.volume = expVol;
            updateVolumeUI();
            
            if (playerState.outputDevice === 'debian_alsa') {
                fetch('/api/music/volume-server', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ volume: expVol })
                });
            }
        };

        volumeBarBg.addEventListener('mousedown', (e) => { isVolumeDragging = true; updateVolume(e); });
        window.addEventListener('mousemove', (e) => { if (isVolumeDragging) updateVolume(e); });
        window.addEventListener('mouseup', () => { isVolumeDragging = false; });
    }

    if (btnMute) {
        btnMute.onclick = () => {
            playerState.isMuted = !playerState.isMuted;
            const expVol = playerState.isMuted ? 0 : Math.pow(playerState.volume, 3);
            if (audio) audio.volume = expVol;
            updateVolumeUI();
            
            if (playerState.outputDevice === 'debian_alsa') {
                fetch('/api/music/volume-server', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ volume: expVol })
                });
            }
        };
    }

    audio.onended = () => {
        if (playerState.isLoop) {
            audio.currentTime = 0;
            audio.play();
        } else {
            playNext();
        }
    };

    btnNext.onclick = playNext;
    btnPrev.onclick = playPrev;

    btnShuffle.onclick = () => {
        playerState.isShuffle = !playerState.isShuffle;
        btnShuffle.classList.toggle('active', playerState.isShuffle);
    };
    btnLoop.onclick = () => {
        playerState.isLoop = !playerState.isLoop;
        btnLoop.classList.toggle('active', playerState.isLoop);
    };
}

function getNextTrack(direction = 1) {
    if (playerState.playlist.length === 0) return null;
    if (playerState.isShuffle && direction === 1) {
        const randomIndex = Math.floor(Math.random() * playerState.playlist.length);
        return playerState.playlist[randomIndex];
    }
    
    let currentIndex = playerState.playlist.indexOf(playerState.currentPlaying);
    if (currentIndex === -1) currentIndex = 0;
    else {
        currentIndex += direction;
        if (currentIndex >= playerState.playlist.length) currentIndex = 0;
        if (currentIndex < 0) currentIndex = playerState.playlist.length - 1;
    }
    return playerState.playlist[currentIndex];
}

function playNext() {
    const nextFile = getNextTrack(1);
    if (nextFile) playMusic(nextFile);
}
function playPrev() {
    const prevFile = getNextTrack(-1);
    if (prevFile) playMusic(prevFile);
}

function playMusic(filename) {
    playerState.currentPlaying = filename;
    
    // UI Güncelleme
    document.querySelectorAll('.music-item').forEach(el => {
        const spans = el.querySelectorAll('span');
        const itemName = spans[1].innerText;
        if (itemName === filename) {
            el.classList.add('playing');
            spans[0].innerText = 'equalizer';
            spans[0].style.color = 'var(--success)';
        } else {
            el.classList.remove('playing');
            spans[0].innerText = 'music_note';
            spans[0].style.color = 'var(--accent-color)';
        }
    });
    
    trackNameEl.innerText = filename;
    
    fetch(`/api/music/cover/${encodeURIComponent(filename)}`)
        .then(res => {
            if (res.ok) return res.blob();
            throw new Error('Cover not found');
        })
        .then(blob => {
            const objectURL = URL.createObjectURL(blob);
            coverArtImg.src = objectURL;
            coverArtImg.style.opacity = '1';
            defaultCoverIcon.style.opacity = '0';
        })
        .catch(err => {
            coverArtImg.style.opacity = '0';
            defaultCoverIcon.style.opacity = '1';
        });

    if (playerState.outputDevice === 'browser') {
        fetch('/api/music/stop-server', { method: 'POST' }); 
        audio.src = `/api/music/play/${encodeURIComponent(filename)}`;
        audio.play().catch(e => console.error("Otomatik oynatma engellendi", e));
        
        progressBarBg.style.pointerEvents = 'auto';
        progressBarBg.style.opacity = '1';
    } else {
        audio.pause();
        // Müziği başlattığımızda ses seviyesini de hemen sunucuya bildiriyoruz
        fetch('/api/music/play-server', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: filename })
        }).then(() => {
            fetch('/api/music/volume-server', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ volume: Math.pow(playerState.volume, 3) })
            });
        });

        playerState.isPlaying = true;
        playPauseIcon.innerText = 'pause';
        
        progressBarBg.style.pointerEvents = 'auto';
        progressBarBg.style.opacity = '1';
        timeCurrent.innerText = '00:00';
        progressBarFill.style.width = '0%';
        progressBarHandle.style.left = '0%';
        
        // Sunucu oynatma durumu takibi için anlık (1 saniyelik) polling sistemi başlatılıyor (Eğer yoksa)
        if (!window.serverStatusInterval) {
            window.serverStatusInterval = setInterval(() => {
                if (playerState.outputDevice === 'debian_alsa') {
                    fetch('/api/music/status-server').then(r => r.json()).then(data => {
                        if (data.totalSec > 0 && !isProgressDragging) {
                            timeCurrent.innerText = formatTime(data.currentSec);
                            timeTotal.innerText = formatTime(data.totalSec);
                            const percent = (data.currentSec / data.totalSec) * 100;
                            if (progressBarFill) progressBarFill.style.width = `${percent}%`;
                            if (progressBarHandle) progressBarHandle.style.left = `${percent}%`;
                            
                            // Sunucu çalmayı bitirdiyse sıradakine geç
                            if (!data.isPlaying && playerState.isPlaying && data.currentSec >= data.totalSec * 0.98) {
                                playerState.isPlaying = false;
                                playPauseIcon.innerText = 'play_arrow';
                                if (playerState.isLoop) {
                                    playMusic(playerState.currentPlaying);
                                } else {
                                    playNext();
                                }
                            }
                        }
                    }).catch(e => {});
                }
            }, 1000);
        }
    }
}
