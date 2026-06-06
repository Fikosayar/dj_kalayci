const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mm = require('music-metadata');
const { exec, spawn } = require('child_process');

let currentServerProcess = null; // Sunucuda çalan müziğin process kaydı
let radioServerProcess   = null; // Sunucuda çalan radyo stream process kaydı
let radioServerUrl       = null; // Şu an çalan radyo URL'i (volume restart için)

// Yardımcı: her iki process'i de durdur
function killAllServerAudio() {
    if (currentServerProcess) {
        try { currentServerProcess.stdin.write('Q\n'); } catch(e) {}
        try { currentServerProcess.kill('SIGKILL'); } catch(e) {}
        currentServerProcess = null;
    }
    if (radioServerProcess) {
        // curl pipe process'i de durdur
        if (radioServerProcess._curlProcess) {
            try { radioServerProcess._curlProcess.kill('SIGKILL'); } catch(e) {}
        }
        try { radioServerProcess.kill('SIGKILL'); } catch(e) {}
        radioServerProcess = null;
    }
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Multer / proxy kökenli 413 hatalarını yakala
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE' || err.status === 413) {
        return res.status(413).json({ error: 'Dosya çok büyük. Maksimum 500MB.' });
    }
    next(err);
});

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

// Konfigürasyon okuma fonksiyonu
function getConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        } catch (e) {
            console.error("Config okuma hatası:", e);
        }
    }
    // Varsayılan klasör (Uygulamanın çalıştığı yerdeki 'uploads' klasörü)
    const defaultCfg = { uploadPath: path.join(process.cwd(), 'uploads') };
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultCfg, null, 2), 'utf-8'); } catch(e){}
    return defaultCfg;
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// Uygulama ilk açıldığında varsayılan klasör yoksa oluştur
const defaultConfig = getConfig();
if (!fs.existsSync(defaultConfig.uploadPath)) {
    fs.mkdirSync(defaultConfig.uploadPath, { recursive: true });
}

// --- API ENDPOINTS ---

app.get('/api/settings/upload-path', (req, res) => {
    const config = getConfig();
    res.json({ uploadPath: config.uploadPath });
});

app.post('/api/settings/upload-path', (req, res) => {
    const { uploadPath } = req.body;
    if (!uploadPath) {
        return res.status(400).json({ error: 'Yol (path) gereklidir.' });
    }

    try {
        const stats = fs.statSync(uploadPath);
        if (!stats.isDirectory()) {
            return res.status(400).json({ error: 'Seçilen yol bir klasör değil' });
        }
    } catch (err) {
        return res.status(400).json({ error: 'Klasör bulunamadı veya erişilemiyor' });
    }

    const config = getConfig();
    config.uploadPath = uploadPath;
    saveConfig(config);

    res.json({ success: true, uploadPath: config.uploadPath });
});

app.get('/api/directories', (req, res) => {
    let targetPath = req.query.path || process.cwd();

    try {
        const absolutePath = path.resolve(targetPath);

        fs.readdir(absolutePath, { withFileTypes: true }, (err, files) => {
            if (err) {
                // Windows'taki sistem izin hatalarını tolere et (EPERM vb.)
                return res.status(200).json({ currentPath: absolutePath, directories: [], error: 'Erişim reddedildi' });
            }

            const directories = files
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            res.json({ currentPath: absolutePath, directories: directories });
        });
    } catch (error) {
        res.status(500).json({ error: 'Geçersiz yol' });
    }
});

// Multer Storage Ayarları
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const config = getConfig();
        cb(null, config.uploadPath);
    },
    filename: (req, file, cb) => {
        // Dosya ismini ve uzantısını ayır
        const parsed = path.parse(file.originalname);
        // İsimdeki geçersiz karakterleri temizle
        const safeName = parsed.name.replace(/[^a-zA-Z0-9.\-]/g, '_');
        // İsim - Timestamp . uzantı şeklinde birleştir
        cb(null, safeName + '-' + Date.now() + parsed.ext);
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB max per file
});

app.post('/api/upload', upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Dosya seçilmedi' });
    }
    res.json({ success: true, message: `${req.files.length} dosya başarıyla yüklendi.` });
});

// --- PARÇALI (CHUNKED) YÜKLEME ENDPOINT'İ ---
// Büyük dosyalar için 4MB'lık parçalar halinde yükleme
const CHUNK_TMP_DIR = path.join(process.cwd(), '.chunks_tmp');
if (!fs.existsSync(CHUNK_TMP_DIR)) fs.mkdirSync(CHUNK_TMP_DIR, { recursive: true });

app.post('/api/upload/chunk', (req, res) => {
    const chunkIndex  = parseInt(req.headers['x-chunk-index']  || '0');
    const totalChunks = parseInt(req.headers['x-total-chunks'] || '1');
    const fileId      = req.headers['x-file-id'] || Date.now().toString();
    const originalName = req.headers['x-filename']
        ? decodeURIComponent(req.headers['x-filename'])
        : 'upload.mp3';

    const fileDir = path.join(CHUNK_TMP_DIR, fileId);
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

    const chunkPath = path.join(fileDir, `chunk_${String(chunkIndex).padStart(6, '0')}`);
    const ws = fs.createWriteStream(chunkPath);

    req.pipe(ws);

    ws.on('finish', () => {
        const received = fs.readdirSync(fileDir).filter(f => f.startsWith('chunk_')).length;

        if (received < totalChunks) {
            // Henüz tüm parçalar gelmedi
            return res.json({ success: true, done: false, received, total: totalChunks });
        }

        // Tüm parçalar geldi — birleştir
        const config = getConfig();
        const parsed  = path.parse(originalName);
        const safeName = parsed.name.replace(/[^a-zA-Z0-9.\-]/g, '_');
        const finalName = safeName + '-' + Date.now() + parsed.ext;
        const finalPath = path.join(config.uploadPath, finalName);

        const out = fs.createWriteStream(finalPath);
        const chunks = fs.readdirSync(fileDir)
            .filter(f => f.startsWith('chunk_'))
            .sort(); // padStart sayesinde alfabetik = sıralı

        (function writeNext(i) {
            if (i >= chunks.length) { out.end(); return; }
            const data = fs.readFileSync(path.join(fileDir, chunks[i]));
            out.write(data, () => writeNext(i + 1));
        })(0);

        out.on('finish', () => {
            // Geçici parça klasörünü temizle
            try { fs.rmSync(fileDir, { recursive: true, force: true }); } catch(e) {}
            res.json({ success: true, done: true, filename: finalName });
        });

        out.on('error', (err) => {
            console.error('Birleştirme hatası:', err);
            res.status(500).json({ error: 'Dosya birleştirilemedi' });
        });
    });

    ws.on('error', (err) => {
        console.error('Chunk yazma hatası:', err);
        res.status(500).json({ error: 'Chunk yazılamadı' });
    });
});

// Müzikleri listeleme API'si (Pagination destekli)
app.get('/api/music', (req, res) => {
    const config = getConfig();
    const uploadPath = config.uploadPath;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    try {
        if (!fs.existsSync(uploadPath)) {
            return res.json({ files: [], total: 0, totalPages: 0, current: page });
        }

        fs.readdir(uploadPath, (err, files) => {
            if (err) {
                return res.status(500).json({ error: 'Klasör okunamadı' });
            }

            // Sadece mp3 dosyalarını listele ve sondan başa (en yeni) sırala
            const musicFiles = files
                .filter(f => f.toLowerCase().endsWith('.mp3') || f.toLowerCase().endsWith('.wav'))
                .reverse();

            const startIndex = (page - 1) * limit;
            const endIndex = page * limit;

            const paginatedFiles = musicFiles.slice(startIndex, endIndex);

            res.json({
                files: paginatedFiles,
                total: musicFiles.length,
                totalPages: Math.ceil(musicFiles.length / limit),
                current: page
            });
        });
    } catch (error) {
        res.status(500).json({ error: 'Müzik listesi alınamadı' });
    }
});

// Müziği Stream Eden (Oynatan) API
app.get('/api/music/play/:filename', (req, res) => {
    const config = getConfig();
    const filePath = path.join(config.uploadPath, req.params.filename);

    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({ error: 'Dosya bulunamadı' });
    }
});

// Kapak Fotoğrafını (Album Art) Döndüren API
app.get('/api/music/cover/:filename', async (req, res) => {
    const config = getConfig();
    const filePath = path.join(config.uploadPath, req.params.filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Dosya bulunamadı' });
    }

    try {
        const metadata = await mm.parseFile(filePath);
        if (metadata.common.picture && metadata.common.picture.length > 0) {
            const picture = metadata.common.picture[0];
            res.setHeader('Content-Type', picture.format);
            res.send(picture.data);
        } else {
            res.status(204).end(); // No cover art — no content, no console error
        }
    } catch (error) {
        res.status(204).end(); // Parse error — silently return no content
    }
});

// --- RADYO: PLS/M3U playlist çözümleyici ---
app.get('/api/radio/resolve', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL gerekli' });

    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
        const text = await response.text();

        let streamUrl = null;

        // PLS formatı
        if (url.toLowerCase().endsWith('.pls') || text.includes('[playlist]')) {
            const match = text.match(/File\d+=(.+)/i);
            if (match) streamUrl = match[1].trim();
        }
        // M3U formatı
        else if (url.toLowerCase().endsWith('.m3u') || text.startsWith('#EXTM3U') || text.startsWith('#EXTINF')) {
            const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
            if (lines.length > 0) streamUrl = lines[0];
        }

    res.json({ streamUrl: streamUrl || url });
    } catch (err) {
        res.json({ streamUrl: url }); // Hata olursa orijinal URL'i dön
    }
});

// --- RADYO TEST: Tarayıcıdan doğrudan test et ---
// Kullanım: /api/radio/test?url=http://radyo-stream-url
app.get('/api/radio/test', (req, res) => {
    const url = req.query.url;
    if (!url) return res.json({ error: 'URL gerekli. Kullanım: /api/radio/test?url=http://...' });

    killAllServerAudio();

    // curl | mpg123 pipe (mpg123 HTTP destegi yok)
    const curlProc = spawn('curl', ['-sL', '--no-buffer', url]);
    const mpg123Proc = spawn('mpg123', ['-o', 'alsa', '-f', '16000', '-']);
    curlProc.stdout.pipe(mpg123Proc.stdin);

    radioServerProcess = mpg123Proc;
    radioServerProcess._curlProcess = curlProc;
    const thisRadio = mpg123Proc;
    let output = [];

    curlProc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) { output.push('[curl stderr] ' + msg); console.log('[Radio Test curl]', msg); }
    });
    curlProc.on('close', (code) => output.push(`[curl closed] code: ${code}`));

    mpg123Proc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        output.push('[mpg123 stderr] ' + msg);
        console.log('[Radio Test mpg123]', msg);
    });
    mpg123Proc.on('close', (code) => {
        console.log(`[Radio Test] mpg123 kapandi (code: ${code})`);
        output.push(`[mpg123 closed] code: ${code}`);
        if (radioServerProcess === thisRadio) radioServerProcess = null;
    });
    mpg123Proc.on('error', (err) => {
        output.push('[mpg123 error] ' + err.message);
    });

    // 4 saniye bekle, sonuçları döndür
    setTimeout(() => {
        res.json({
            status: mpg123Proc.killed ? 'killed' : (mpg123Proc.exitCode !== null ? `exited(${mpg123Proc.exitCode})` : 'running'),
            curlPid: curlProc.pid,
            mpg123Pid: mpg123Proc.pid,
            output: output,
            message: mpg123Proc.exitCode === null ? 'Çalışıyor — hoparlörden ses kontrolü yapın' : undefined
        });
    }, 4000);
});

// --- RADYO HELPER: curl|mpg123 pipe ile stream baslat ---
function startRadioStream(url, vol01) {
    // Onceki sesleri durdur
    killAllServerAudio();
    radioServerUrl = url;

    const scale = Math.round(Math.pow(Math.max(0, Math.min(1, vol01)), 3) * 32768);
    const finalScale = Math.max(100, scale);

    const curlProcess = spawn('curl', ['-sL', '--no-buffer', url]);
    const mpg123Process = spawn('mpg123', ['-o', 'alsa', '-f', String(finalScale), '-']);
    curlProcess.stdout.pipe(mpg123Process.stdin);

    radioServerProcess = mpg123Process;
    radioServerProcess._curlProcess = curlProcess;
    const thisRadio = mpg123Process;

    console.log(`[Radio] curl|mpg123 baslatildi - scale: ${finalScale}, vol: ${vol01}`);

    curlProcess.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.log('[Radio curl]', m); });
    curlProcess.on('error', (e) => console.error('[Radio curl err]', e.message));
    curlProcess.on('close', (c) => console.log(`[Radio] curl kapandi (${c})`));

    mpg123Process.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.log('[Radio mpg123]', m); });
    mpg123Process.on('close', (c) => { console.log(`[Radio] mpg123 kapandi (${c})`); if (radioServerProcess === thisRadio) radioServerProcess = null; });
    mpg123Process.on('error', (e) => { console.error('[Radio mpg123 err]', e.message); if (radioServerProcess === thisRadio) radioServerProcess = null; });
}

// --- RADYO SUNUCU OYNATMA ---
app.post('/api/radio/play-server', (req, res) => {
    const { url, volume } = req.body;
    if (!url) return res.status(400).json({ error: 'URL gerekli' });
    console.log(`[Radio] Istek alindi - URL: ${url}, Volume: ${volume}`);
    const vol = volume !== undefined ? volume : 0.7;
    startRadioStream(url, vol);
    res.json({ success: true, message: 'Radyo sunucuda caliniyor.' });
});

app.post('/api/radio/stop-server', (req, res) => {
    if (radioServerProcess) {
        if (radioServerProcess._curlProcess) {
            try { radioServerProcess._curlProcess.kill('SIGKILL'); } catch(e) {}
        }
        try { radioServerProcess.kill('SIGKILL'); } catch(e) {}
        radioServerProcess = null;
    }
    radioServerUrl = null;
    res.json({ success: true });
});

// --- KÜTÜPHANE: Tüm dosyalar + boyut bilgisi ---
app.get('/api/library', (req, res) => {
    const config = getConfig();
    const uploadPath = config.uploadPath;
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 30;
    const search = (req.query.search || '').toLowerCase();

    try {
        if (!fs.existsSync(uploadPath)) {
            return res.json({ files: [], total: 0, totalPages: 0, current: page, totalSize: 0 });
        }

        const allFiles = fs.readdirSync(uploadPath)
            .filter(f => /\.(mp3|wav|flac|ogg|aac|m4a)$/i.test(f))
            .filter(f => !search || f.toLowerCase().includes(search))
            .sort((a, b) => a.localeCompare(b, 'tr'));

        const totalSize = allFiles.reduce((sum, f) => {
            try { return sum + fs.statSync(path.join(uploadPath, f)).size; } catch { return sum; }
        }, 0);

        const totalPages = Math.max(1, Math.ceil(allFiles.length / limit));
        const pageFiles  = allFiles.slice((page - 1) * limit, page * limit);

        const files = pageFiles.map(f => {
            let size = 0;
            try { size = fs.statSync(path.join(uploadPath, f)).size; } catch {}
            return { name: f, size };
        });

        res.json({ files, total: allFiles.length, totalPages, current: page, totalSize });
    } catch (err) {
        res.status(500).json({ error: 'Kütüphane okunamadı' });
    }
});

// --- DOSYA SİL ---
app.delete('/api/music/:filename', (req, res) => {
    const config = getConfig();
    const filename = decodeURIComponent(req.params.filename);

    // Güvenlik: path traversal engelle
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Geçersiz dosya adı' });
    }

    const filePath = path.join(config.uploadPath, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Dosya bulunamadı' });
    }

    try {
        fs.unlinkSync(filePath);
        console.log(`Silindi: ${filename}`);
        res.json({ success: true, message: `${filename} silindi.` });
    } catch (err) {
        console.error('Silme hatası:', err);
        res.status(500).json({ error: 'Dosya silinemedi' });
    }
});

// --- SES CİHAZLARI VE SUNUCU UZAKTAN KUMANDA API'LERİ ---

app.get('/api/devices', (req, res) => {
    res.json([
        { id: 'browser', name: 'Kendi Cihazım (Tarayıcı)', icon: 'laptop_mac', description: 'Müzik şu anki cihazınızdan çalar.' },
        { id: 'debian_alsa', name: 'Sunucu Hoparlörü', icon: 'speaker', description: 'Müzik ana sunucu (Debian) hoparlöründen çalar.' }
    ]);
});

// --- DEBUG: mpg123 & ses durumu ---
app.get('/api/debug/audio', (req, res) => {
    exec('which mpg123 && mpg123 --version 2>&1 | head -2', (err, stdout) => {
        const mpg123Info = err ? `HATA: ${err.message}` : stdout.trim();
        exec('aplay -l 2>&1', (err2, stdout2) => {
            const alsaDevices = err2 ? `HATA: ${err2.message}` : stdout2.trim();
            exec('amixer sget Master 2>/dev/null || amixer sget PCM 2>/dev/null || echo "mixer bulunamadi"', (err3, stdout3) => {
                res.json({
                    mpg123: mpg123Info,
                    alsaDevices: alsaDevices,
                    alsaMixer: (stdout3 || '').trim().substring(0, 400),
                    musicProcessRunning: !!currentServerProcess,
                    radioProcessRunning: !!radioServerProcess,
                    serverPlayerState
                });
            });
        });
    });
});

let serverPlayerState = {
    isPlaying: false,
    currentSec: 0,
    totalSec: 0,
    totalFrames: 0,
    lastVolume: 70  // mpg123 percent (0-100), default %70
};

// --- ANTİ-BUZZ: aplay yerine mpg123 ile sessiz ses çal (ALSA'yı bloklamaz) ---
// Not: aplay -D default /dev/zero ALSA'yı exclus lock'layıp mpg123'ün açmasını engelliyordu.
// mpg123 ile sessiz bir WAV döngüsü yerine, tamamen kaldırdık çünkü dmix zaten karıştırmayı
// handle ediyor ve çoğu modern hoparlör uyku moduna girmez.

// --- ALSA Sistem Ses Seviyesi Sıfırlama + ANTİ-BUZZ ---
// Container başlarken ALSA master volume'u %100'e getir, hoparlor uyku modunu engelle
setTimeout(() => {
    // Mixer'ları çıkar ve %100 yap
    exec('amixer sset Master 100% unmute 2>/dev/null || true', (err) => {
        if (!err) console.log('[ALSA] Master volume %100 ayarlandı.');
    });
    exec('amixer sset PCM 100% unmute 2>/dev/null || true', () => {});
    exec('amixer sset Speaker 100% unmute 2>/dev/null || true', () => {});
    exec('amixer sset Headphone 100% unmute 2>/dev/null || true', () => {});
    exec('amixer sset "Front" 100% unmute 2>/dev/null || true', () => {});

    // ANTI-BUZZ: aplay -D dmixer ile sessiz ses çal.
    // "-D dmixer" = directly targets the dmix plugin, shared access, does NOT block mpg123.
    // "-D default" blocked because it went through the plug layer with exclusive hw open.
    const antiBuzz = spawn('aplay', ['-D', 'dmixer', '-c', '2', '-r', '44100', '-f', 'S16_LE', '/dev/zero']);
    antiBuzz.on('error', (err) => console.log('[Anti-Buzz] aplay bulunamadı veya hata:', err.message));
    antiBuzz.stderr.on('data', (d) => {
        const msg = d.toString();
        if (!msg.includes('Playing raw')) console.log('[Anti-Buzz]', msg.trim());
    });
    console.log('[Anti-Buzz] Hoparlor uyuşönleme başlatıldı.');
}, 3000);

app.post('/api/music/play-server', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Dosya adı gerekli' });

    const config = getConfig();
    const filePath = path.join(config.uploadPath, filename);

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Dosya bulunamadı' });

    // Her ikisini de durdur (müzik veya radyo çalıyor olabilir)
    killAllServerAudio();

    // mpg123'ü "Remote Control" (-R) modunda başlatıyoruz ki komut gönderebilelim
    currentServerProcess = spawn('mpg123', ['-R', '-o', 'alsa']);
    
    // Process referansı kaydet — close handler için race condition önleme
    const thisProcess = currentServerProcess;

    currentServerProcess.stderr.on('data', (data) => {
        console.log('[mpg123 stderr]', data.toString().trim());
    });
    currentServerProcess.on('error', (err) => {
        console.error('[mpg123 spawn error]', err.message);
        if (currentServerProcess === thisProcess) {
            currentServerProcess = null;
            serverPlayerState.isPlaying = false;
        }
    });
    currentServerProcess.on('close', (code) => {
        console.log(`[mpg123 closed] code: ${code}`);
        // Sadece HALA bizim process ise null yap — yeni process'i silmeyelim
        if (currentServerProcess === thisProcess) {
            currentServerProcess = null;
            serverPlayerState.isPlaying = false;
        }
    });

    // İlerleme Çubuğu İçin Standart Çıktıyı Dinleme
    currentServerProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.startsWith('@F ')) {
                // @F <current_frame> <frames_left> <current_sec> <sec_left>
                const parts = line.split(' ').filter(Boolean); // boşlukları temizle
                if (parts.length >= 5) {
                    const currentFrame = parseInt(parts[1]);
                    const framesLeft = parseInt(parts[2]);
                    serverPlayerState.currentSec = parseFloat(parts[3]);
                    const secLeft = parseFloat(parts[4]);
                    serverPlayerState.totalSec = serverPlayerState.currentSec + secLeft;
                    serverPlayerState.totalFrames = currentFrame + framesLeft;
                    serverPlayerState.isPlaying = true;
                }
            } else if (line.startsWith('@P 0') || line.startsWith('@P 3')) {
                // Şarkı durdu veya bitti
                serverPlayerState.isPlaying = false;
            }
        });
    });

    // Müziği yükle ve çal komutu
    currentServerProcess.stdin.write(`L ${filePath}\n`);

    // Hemen ses seviyesini uygula — mpg123 V komutu 0-100 arası
    const savedVol = serverPlayerState.lastVolume ?? 70;
    currentServerProcess.stdin.write(`V ${savedVol}\n`);
    console.log(`[mpg123] Dosya yüklendi: ${filename}, Volume: ${savedVol}`);

    res.json({ success: true, message: 'Sunucuda çalınmaya başlandı.' });
});

app.post('/api/music/stop-server', (req, res) => {
    if (currentServerProcess) {
        try { currentServerProcess.stdin.write('Q\n'); } catch (e) {}
        currentServerProcess.kill('SIGKILL');
        currentServerProcess = null;
    }
    serverPlayerState.isPlaying = false;
    res.json({ success: true });
});

app.post('/api/music/pause-server', (req, res) => {
    if (currentServerProcess) {
        currentServerProcess.stdin.write('P\n'); // Pause toggle
    }
    res.json({ success: true });
});

let _radioVolTimer = null;
app.post('/api/music/volume-server', (req, res) => {
    const { volume } = req.body; // 0.0 ile 1.0 arası gelir
    if (volume !== undefined) {
        const vol01 = Math.max(0, Math.min(1, volume));
        const percent = Math.round(vol01 * 100);
        serverPlayerState.lastVolume = percent;
        if (currentServerProcess) {
            currentServerProcess.stdin.write(`V ${percent}\n`);
        }
        // Radyo caliyorsa: debounce ile restart (her pixel icin degil)
        if (radioServerProcess && radioServerUrl) {
            clearTimeout(_radioVolTimer);
            _radioVolTimer = setTimeout(() => {
                if (radioServerProcess && radioServerUrl) {
                    console.log(`[Radio Volume] Restart - vol: ${vol01}`);
                    startRadioStream(radioServerUrl, vol01);
                }
            }, 400); // 400ms debounce
        }
        console.log(`[Volume] ${percent}%`);
    }
    res.json({ success: true });
});

app.get('/api/music/status-server', (req, res) => {
    res.json(serverPlayerState);
});

app.post('/api/music/seek-server', (req, res) => {
    const { percent } = req.body;
    if (currentServerProcess && percent !== undefined && serverPlayerState.totalFrames > 0) {
        const targetFrame = Math.round((percent / 100) * serverPlayerState.totalFrames);
        currentServerProcess.stdin.write(`J ${targetFrame}\n`);
    }
    res.json({ success: true });
});

const PORT = process.env.PORT || 8106;

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`Sunucu başarıyla başlatıldı: http://localhost:${PORT}`);
});
