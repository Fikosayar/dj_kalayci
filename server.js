const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mm = require('music-metadata');
const { exec } = require('child_process');

let currentServerProcess = null; // Sunucuda çalan müziğin process kaydı

const app = express();
app.use(express.json()); // JSON body parse etmek için

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
const upload = multer({ storage: storage });

app.post('/api/upload', upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Dosya seçilmedi' });
    }
    res.json({ success: true, message: `${req.files.length} dosya başarıyla yüklendi.` });
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
            res.status(404).send('Cover not found');
        }
    } catch (error) {
        console.error('Metadata okuma hatası:', error.message);
        res.status(500).json({ error: 'Metadata okunamadı' });
    }
});

// --- SES CİHAZLARI VE SUNUCU UZAKTAN KUMANDA API'LERİ ---

app.get('/api/devices', (req, res) => {
    res.json([
        { id: 'browser', name: 'Kendi Cihazım (Tarayıcı)', icon: 'laptop_mac', description: 'Müzik şu anki cihazınızdan çalar.' },
        { id: 'debian_alsa', name: 'Sunucu Hoparlörü', icon: 'speaker', description: 'Müzik ana sunucu (Debian) hoparlöründen çalar.' }
    ]);
});

const { spawn } = require('child_process');

// Sunucu çalar durumu
let serverPlayerState = {
    isPlaying: false,
    currentSec: 0,
    totalSec: 0,
    totalFrames: 0
};

// --- ANTİ-BUZZ (Cızlama Engelleyici) ---
// Hoparlörün uyku moduna geçip cızlamasını engellemek için arka planda sürekli sessizlik çalınır
try {
    const silenceProcess = spawn('aplay', ['-D', 'default', '-c', '2', '-r', '44100', '-f', 'S16_LE', '/dev/zero']);
    silenceProcess.stderr.on('data', d => {
        const msg = d.toString();
        if (!msg.includes('Playing raw data')) console.log('Anti-Buzz:', msg);
    });
} catch (e) {
    console.error('Anti-Buzz başlatılamadı:', e);
}

app.post('/api/music/play-server', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Dosya adı gerekli' });

    const config = getConfig();
    const filePath = path.join(config.uploadPath, filename);

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Dosya bulunamadı' });

    // Eğer zaten mpg123 açıksa kapat
    if (currentServerProcess) {
        try { currentServerProcess.stdin.write('Q\n'); } catch (e) {}
        currentServerProcess.kill('SIGKILL');
        currentServerProcess = null;
    }

    // mpg123'ü "Remote Control" (-R) modunda başlatıyoruz ki komut gönderebilelim
    currentServerProcess = spawn('mpg123', ['-R', '-o', 'alsa']);
    
    currentServerProcess.stderr.on('data', (data) => {
        const err = data.toString();
        if (!err.includes('High Performance')) {
            console.error('Mpg123 Log:', err);
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

app.post('/api/music/volume-server', (req, res) => {
    const { volume } = req.body; // 0.0 ile 1.0 arası gelir
    if (currentServerProcess && volume !== undefined) {
        const percent = Math.round(volume * 100);
        currentServerProcess.stdin.write(`V ${percent}\n`);
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
