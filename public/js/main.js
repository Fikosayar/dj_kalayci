document.addEventListener('DOMContentLoaded', () => {
    // ScreenManager'ı başlatıyoruz
    const screenManager = new ScreenManager('screen-container');
    
    // Varsayılan olarak Ana Sayfa (home) ekranını aç
    screenManager.navigate('home');

    // Sol menüdeki tüm tıklanabilir bağlantıları (li elemanları) al
    const navItems = document.querySelectorAll('.nav-links li');
    
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            // Tıklanan menünün hangi ekranı açması gerektiğini 'data-target' üzerinden al
            const targetScreen = e.currentTarget.getAttribute('data-target');
            
            if (targetScreen) {
                // Menüdeki aktiflik durumunu güncelle (active sınıfı)
                navItems.forEach(nav => nav.classList.remove('active'));
                e.currentTarget.classList.add('active');
                
                // İlgili ekrana geçiş yap
                screenManager.navigate(targetScreen);
            }
        });
    });

    // Ekran değiştiğinde özel bir işlem yapmak istersek bu event'i dinleyebiliriz
    window.addEventListener('screenChanged', (e) => {
        console.log(`Ekran değiştirildi: ${e.detail.screen}`);
        
        // Eğer ayarlar ekranı açıldıysa klasör tarayıcısını başlat
        if (e.detail.screen === 'settings') {
            initDirectoryBrowser();
        }
    });
});

// Klasör Tarayıcı (File Browser) Mantığı
let currentBrowsePath = ''; // Boş bırakıyoruz ki backend'in (process.cwd) döndüğü değerle başlasın

function initDirectoryBrowser() {
    // İlk klasörleri çek
    fetchDirectories(currentBrowsePath);

    const btnUp = document.getElementById('btn-up-dir');
    if (btnUp) {
        btnUp.onclick = () => {
            // Sona '/..' ekleyerek bir üst dizine gitme isteği atıyoruz
            fetchDirectories(currentBrowsePath + '/..');
        };
    }
    
    const saveBtn = document.getElementById('save-location-btn');
    if (saveBtn) {
        saveBtn.onclick = () => {
            alert('Yükleme klasörü başarıyla ayarlandı:\n\n' + currentBrowsePath);
            // İleride bu konumu backend'e POST edip bir config veritabanına/dosyasına yazabiliriz.
        };
    }
}

function fetchDirectories(targetPath) {
    // targetPath boşsa backend kendi bulunduğu dizinden başlar
    const url = targetPath 
        ? `/api/directories?path=${encodeURIComponent(targetPath)}` 
        : `/api/directories`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error('Hata:', data.error);
                alert('Klasör okunamadı: ' + data.error);
                return;
            }
            
            // Backend'den dönen gerçek mutlak yolu (absolute path) değişkene kaydet
            currentBrowsePath = data.currentPath;
            
            // UI inputunu güncelle
            const pathInput = document.getElementById('current-path-input');
            if (pathInput) pathInput.value = currentBrowsePath;

            // Klasör listesini UI'a bas
            const dirList = document.getElementById('dir-list');
            if (dirList) {
                dirList.innerHTML = ''; // Temizle
                
                if (data.directories.length === 0) {
                    dirList.innerHTML = '<div style="padding: 12px; color: var(--text-secondary); text-align: center;">Bu klasörün içinde başka klasör yok.</div>';
                }

                data.directories.forEach(dir => {
                    const div = document.createElement('div');
                    div.style.padding = '8px 12px';
                    div.style.cursor = 'pointer';
                    div.style.borderRadius = '6px';
                    div.style.display = 'flex';
                    div.style.alignItems = 'center';
                    div.style.gap = '12px';
                    div.style.transition = 'background 0.2s ease';
                    
                    div.innerHTML = `<span class="material-symbols-rounded" style="color: #fbbf24;">folder</span> <span>${dir}</span>`;
                    
                    // Hover efekti
                    div.onmouseover = () => div.style.background = 'rgba(255,255,255,0.1)';
                    div.onmouseout = () => div.style.background = 'transparent';
                    
                    // Tıklama ile o klasörün içine gir
                    div.onclick = () => {
                        fetchDirectories(currentBrowsePath + '/' + dir);
                    };
                    
                    dirList.appendChild(div);
                });
            }
        })
        .catch(err => {
            console.error('Fetch hatası:', err);
            alert('Sunucuyla bağlantı kurulamadı!');
        });
}
