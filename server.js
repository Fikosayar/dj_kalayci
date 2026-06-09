const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mm = require('music-metadata');
const { exec, spawn } = require('child_process');

let currentServerProcess = null; // Sunucuda çalan müziğin process kaydı
let radioServerProcess   = null; // Sunucuda çalan radyo stream process kaydı
let radioServerUrl       = null; // Şu an çalan radyo URL'i (volume restart için)

// Pipe hataları Node.js'i çökertmesin
process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED' || err.code === 'ERR_STREAM_WRITE_AFTER_END') {
        console.log('[Process] Pipe hatası yakalandı (crash önlendi):', err.code);
        return; // Çökme, devam et
    }
    console.error('[Process] Yakalanmamış hata:', err);
});

// Yardımcı: her iki process'i de durdur
function killAllServerAudio() {
    if (currentServerProcess) {
        try { currentServerProcess.stdin.write('Q\n'); } catch(e) {}
        try { currentServerProcess.kill('SIGKILL'); } catch(e) {}
        currentServerProcess = null;
    }
    if (radioServerProcess) {
        const curl = radioServerProcess._curlProcess;
        const mpg = radioServerProcess;
        radioServerProcess = null;

        if (mpg._isHLS) {
            // HLS: sadece ffmpeg process'i var
            try { mpg.kill('SIGKILL'); } catch(e) {}
        } else {
            // MP3: curl | mpg123 pipe — önce kopar, sonra kill
            if (curl) {
                try { curl.stdout.unpipe(); } catch(e) {}
                try { curl.stdout.destroy(); } catch(e) {}
                try { curl.kill('SIGKILL'); } catch(e) {}
            }
            try { mpg.stdin.destroy(); } catch(e) {}
            try { mpg.kill('SIGKILL'); } catch(e) {}
        }
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

const DATA_DIR    = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// data/ klasörünü oluştur (ilk çalıştırmada veya yeni volume mount sonrası)
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('[Data] /app/data klasörü oluşturuldu.');
}

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

// ============================================================
// KAYITLI RADYO İSTASYONLARI — Sunucu tarafı kalıcı depolama
// ============================================================
const STATIONS_FILE = path.join(DATA_DIR, 'stations.json');

function readStations() {
    try {
        if (fs.existsSync(STATIONS_FILE)) {
            return JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf-8'));
        }
    } catch(e) { console.error('[Stations] Okuma hatası:', e.message); }
    return [];
}

function writeStations(list) {
    try {
        fs.writeFileSync(STATIONS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch(e) { console.error('[Stations] Yazma hatası:', e.message); }
}

// Tüm istasyonları listele
app.get('/api/stations', (req, res) => {
    res.json(readStations());
});

// Yeni istasyon ekle
app.post('/api/stations', (req, res) => {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name ve url gerekli' });
    if (!url.startsWith('http')) return res.status(400).json({ error: 'Geçersiz URL' });

    const list = readStations();
    // Aynı URL varsa güncelle
    const existing = list.findIndex(s => s.url === url);
    if (existing >= 0) {
        list[existing].name = name;
        writeStations(list);
        return res.json({ success: true, station: list[existing], updated: true });
    }
    const station = { id: Date.now().toString(), name, url };
    list.push(station);
    writeStations(list);
    console.log(`[Stations] Eklendi: ${name}`);
    res.json({ success: true, station });
});

// İstasyon sil
app.delete('/api/stations/:id', (req, res) => {
    const { id } = req.params;
    let list = readStations();
    const before = list.length;
    list = list.filter(s => s.id !== id);
    if (list.length === before) return res.status(404).json({ error: 'İstasyon bulunamadı' });
    writeStations(list);
    console.log(`[Stations] Silindi: ${id}`);
    res.json({ success: true });
});

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
// --- MP3 SÜRE ÖNBELLEK (ffprobe ile gerçek süre) ---
const _durCache = {}; // filename → saniye

function getFileDuration(filePath) {
    const name = path.basename(filePath);
    if (_durCache[name]) return Promise.resolve(_durCache[name]);
    return new Promise((resolve) => {
        exec(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`, (err, stdout) => {
            if (!err && stdout && stdout.trim()) {
                const sec = parseFloat(stdout.trim());
                if (!isNaN(sec) && sec > 0) { _durCache[name] = Math.round(sec); resolve(Math.round(sec)); return; }
            }
            resolve(0);
        });
    });
}

app.get('/api/music', async (req, res) => {
    const config = getConfig();
    const uploadPath = config.uploadPath;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    try {
        if (!fs.existsSync(uploadPath)) {
            return res.json({ files: [], durations: {}, total: 0, totalPages: 0, current: page });
        }

        fs.readdir(uploadPath, async (err, files) => {
            if (err) return res.status(500).json({ error: 'Klasör okunamadı' });

            const musicFiles = files
                .filter(f => f.toLowerCase().endsWith('.mp3') || f.toLowerCase().endsWith('.wav'))
                .reverse();

            const startIndex = (page - 1) * limit;
            const paginatedFiles = musicFiles.slice(startIndex, startIndex + limit);

            // Gerçek süreleri ffprobe ile oku (önbellekten veya ffprobe'dan)
            const durations = {};
            await Promise.all(paginatedFiles.map(async (f) => {
                durations[f] = await getFileDuration(path.join(uploadPath, f));
            }));

            res.json({
                files: paginatedFiles,
                durations,
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
    curlProc.stdout.on('error', (e) => { if (e.code !== 'EPIPE') console.log('[Radio Test pipe err]', e.code); });
    mpg123Proc.stdin.on('error', (e) => { if (e.code !== 'EPIPE' && e.code !== 'ERR_STREAM_DESTROYED') console.log('[Radio Test stdin err]', e.code); });
    curlProc.stdout.pipe(mpg123Proc.stdin, { end: false });

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

// --- RADYO HELPER ---
// ffmpeg tüm formatları destekler: MP3, AAC, HLS/m3u8, Icecast, PLS, uzantısız URL
let _radioStartTime  = 0;
let _radioRetryCount = 0;   // Otomatik yeniden bağlanma sayacı
let _lastRadioVol    = 0.5; // Son kullanılan ses seviyesi (reconnect için)

function startRadioStream(url, vol01) {
    killAllServerAudio();
    radioServerUrl   = url;
    _radioStartTime  = Date.now();
    _lastRadioVol    = vol01;
    // Kullanıcı bilerek başlatıyorsa sayacı sıfırla
    // (reconnect içinden çağrıldığında sayaç korunur)
    if (url !== radioServerUrl || _radioRetryCount === 0) {
        // Yeni URL = sıfırla
    }

    const vol01c    = Math.max(0, Math.min(1, vol01));
    const cubic     = Math.pow(vol01c, 3);
    const volLinear = cubic.toFixed(6);

    // ffmpeg: evrensel stream çözücü
    // -re        : gerçek zamanlı okuma (stream'i buffer dolana kadar beklemez)
    // -i url     : girdi
    // -vn        : video kanalını atla
    // -af volume : ses seviyesi (cubic eğri sonrası 0.0-1.0)
    // -f alsa    : ALSA çıkışı
    // default    : asound.conf → plug → dmixer zinciri
    const proc = spawn('ffmpeg', [
        '-re',
        '-i', url,
        '-vn',
        '-af', `volume=${volLinear}`,
        '-f', 'alsa', 'default'
    ]);

    radioServerProcess              = proc;
    proc._curlProcess               = null;  // curl yok — killAll uyumluluğu için
    proc._isHLS                     = true;  // "HLS" bayrağı = ffmpeg modunda → killAll'da doğru dal
    const thisRadio                 = proc;

    console.log(`[Radio] ffmpeg başlatıldı — url: ${url} | vol: ${volLinear} (ham: ${Math.round(vol01c*100)}%)`);

    // Stderr: frame/size satırlarını filtrele, gerisini logla
    let stderrBuf = '';
    proc.stderr.on('data', (d) => {
        stderrBuf += d.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop();
        lines.forEach(l => {
            l = l.trim();
            if (l && !l.startsWith('frame=') && !l.startsWith('size=') && !l.includes('kb/s') && l.length > 3) {
                console.log('[Radio ffmpeg]', l.substring(0, 160));
            }
        });
    });
    proc.stdout.on('data', () => {}); // stdout buffer dolmasın
    proc.on('close', (c, sig) => {
        console.log(`[Radio] ffmpeg kapandı (code:${c} sig:${sig})`);
        if (radioServerProcess !== thisRadio) return; // Başka bir process başladıysa dokunma
        radioServerProcess = null;

        // SIGKILL = biz bilinçli durdurduk → yeniden bağlanma
        // Diğer durumlarda (session süresi, 404, ağ kesintisi) → otomatik yeniden bağlan
        if (sig === 'SIGKILL' || sig === 'SIGTERM') {
            console.log('[Radio] Kullanıcı durdurdu, yeniden bağlanılmıyor.');
            return;
        }

        if (radioServerUrl === url && _radioRetryCount < 10) {
            _radioRetryCount++;
            const delay = Math.min(3000 * _radioRetryCount, 15000); // 3s → 6s → ... → 15s
            console.log(`[Radio] Stream kesildi (${c}), ${delay/1000}sn sonra yeniden bağlanılıyor... (deneme ${_radioRetryCount}/10)`);
            setTimeout(() => {
                if (radioServerUrl === url && !radioServerProcess) {
                    startRadioStream(url, _lastRadioVol);
                }
            }, delay);
        } else if (_radioRetryCount >= 10) {
            console.log('[Radio] Maksimum yeniden bağlanma denemesi aşıldı, durduruluyor.');
            radioServerUrl = null;
            _radioRetryCount = 0;
        }
    });
    proc.on('error', (e) => {
        console.error('[Radio] ffmpeg spawn hata:', e.message);
        if (radioServerProcess === thisRadio) radioServerProcess = null;
    });
}

// --- RADYO DURUMU (Frontend polling için) ---
app.get('/api/radio/status', (req, res) => {
    const isPlaying      = !!radioServerProcess;
    const isReconnecting = !radioServerProcess && !!radioServerUrl && _radioRetryCount > 0;
    res.json({
        isPlaying,
        isReconnecting,
        url:        radioServerUrl || null,
        retryCount: _radioRetryCount,
    });
});

// --- RADYO SUNUCU OYNATMA ---
app.post('/api/radio/play-server', (req, res) => {
    const { url, volume } = req.body;
    if (!url) return res.status(400).json({ error: 'URL gerekli' });
    console.log(`[Radio] Istek alindi - URL: ${url}, Volume: ${volume}`);
    const vol = volume !== undefined ? volume : 0.7;
    _radioRetryCount = 0; // Kullanıcı yeni stream başlatıyor — retry sayacını sıfırla
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
    radioServerUrl   = null;  // URL temizle — auto-reconnect durduruluyor
    _radioRetryCount = 0;     // Sayacı sıfırla
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
    const { volume } = req.body; // Ham 0.0-1.0 arası (cubic BURADA uygulanir)
    if (volume !== undefined) {
        const vol01 = Math.max(0, Math.min(1, volume)); // ham deger
        const cubic = Math.pow(vol01, 3);               // küpsel eğri
        // mpg123 V komutu: 0-100 lineer (cubic sonrası)
        const percent = Math.round(cubic * 100);
        serverPlayerState.lastVolume = percent;
        if (currentServerProcess) {
            currentServerProcess.stdin.write(`V ${percent}\n`);
        }
        // Radyo caliyorsa: debounce ile restart
        // KURAL: Radyo yeni başlatıldıysa (< 3sn) restart YAPMA
        if (radioServerProcess && radioServerUrl) {
            clearTimeout(_radioVolTimer);
            _radioVolTimer = setTimeout(() => {
                const sinceStart = Date.now() - _radioStartTime;
                if (radioServerProcess && radioServerUrl && sinceStart > 3000) {
                    console.log(`[Radio Volume] Restart - vol: ${vol01}, cubic: ${cubic.toFixed(4)}`);
                    startRadioStream(radioServerUrl, vol01);
                } else if (sinceStart <= 3000) {
                    console.log(`[Radio Volume] Restart atlandı — radyo ${Math.round(sinceStart/100)/10}sn önce başlatıldı`);
                }
            }, 600);
        }
        console.log(`[Volume] ham:${Math.round(vol01*100)}% → cubic:${percent}%`);
    }
    res.json({ success: true });
});

app.get('/api/music/status-server', (req, res) => {
    // player.js: state.time = s.time, state.duration = s.duration
    res.json({
        ...serverPlayerState,
        time:     serverPlayerState.currentSec,
        duration: serverPlayerState.totalSec,
    });
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
