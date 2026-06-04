/**
 * ScreenManager Sınıfı
 * Sayfayı yenilemeden sağ taraftaki içerik ekranlarını dinamik olarak yönetir.
 */
class ScreenManager {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.currentScreen = null;
        this.screens = new Map(); // Ekranları hafızada tutacağımız yapı
        
        this._initializeTemplates();
    }

    /**
     * HTML içindeki id'si "screen-" ile başlayan tüm template'leri bulur ve sisteme kaydeder.
     */
    _initializeTemplates() {
        const templates = document.querySelectorAll('template[id^="screen-"]');
        templates.forEach(template => {
            const screenName = template.id.replace('screen-', '');
            this.registerScreen(screenName, template.innerHTML);
        });
    }

    /**
     * Yeni bir ekranı sisteme kaydeder.
     * @param {string} name - Ekranın adı (örn: 'home', 'settings')
     * @param {string} htmlContent - Ekranın HTML içeriği
     */
    registerScreen(name, htmlContent) {
        this.screens.set(name, htmlContent);
    }

    /**
     * İstenilen ekrana geçiş yapar.
     * @param {string} name - Geçiş yapılacak ekranın adı.
     */
    navigate(name) {
        if (!this.screens.has(name)) {
            console.error(`Hata: '${name}' adında bir ekran bulunamadı.`);
            return;
        }

        // Mevcut ekran aynıysa tekrar yükleme yapma
        if (this.currentScreen === name) return;

        // Sağ taraftaki container'a yeni HTML'i basıyoruz
        this.container.innerHTML = this.screens.get(name);
        this.currentScreen = name;

        // İsteğe bağlı: Diğer JS kodlarının ekran değişiminden haberdar olması için bir event fırlatıyoruz
        const event = new CustomEvent('screenChanged', { detail: { screen: name } });
        window.dispatchEvent(event);
    }

    /**
     * Şu an aktif olan ekranın adını döndürür.
     */
    getCurrentScreen() {
        return this.currentScreen;
    }
}
