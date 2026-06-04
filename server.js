const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

// Sunucudaki klasörleri canlı okumak için API endpoint
app.get('/api/directories', (req, res) => {
    // req.query.path yoksa, projenin çalıştığı dizinden başla
    let targetPath = req.query.path || process.cwd(); 

    try {
        const absolutePath = path.resolve(targetPath);
        
        fs.readdir(absolutePath, { withFileTypes: true }, (err, files) => {
            if (err) {
                return res.status(500).json({ error: 'Klasör okunamadı', details: err.message });
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
const PORT = process.env.PORT || 3005;

// Statik dosyaları (HTML, CSS, JS) 'public' klasöründen sunuyoruz
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`Sunucu başarıyla başlatıldı: http://localhost:${PORT}`);
});
