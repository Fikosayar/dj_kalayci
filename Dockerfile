FROM node:20-bullseye

# Ses çalmak için gerekli paketleri kuruyoruz
# curl: mpg123'ün HTTP desteği yok, curl ile stream pipe ediyoruz
RUN apt-get update && apt-get install -y mpg123 alsa-utils pulseaudio curl && rm -rf /var/lib/apt/lists/*

# ALSA'nın dmix (karıştırıcı) IPC izin hatasını çözmek için herkese açık bir dmix konfigürasyonu yaratıyoruz
RUN echo 'pcm.!default { type plug; slave.pcm "dmixer" } \n\
pcm.dmixer { type dmix; ipc_key 1024; ipc_key_add_uid false; ipc_perm 0666; \n\
slave { pcm "hw:0,0"; period_time 0; period_size 1024; buffer_size 4096; rate 44100 } }' > /etc/asound.conf

# Uygulama çalışma dizini
WORKDIR /app

# Sadece package.json'u kopyalayıp npm install yapıyoruz (Docker önbelleği için iyi bir pratik)
COPY package*.json ./
RUN npm install

# Geri kalan tüm kodları kopyala
COPY . .

EXPOSE 8106

# Uygulamayı başlat
CMD ["npm", "start"]
