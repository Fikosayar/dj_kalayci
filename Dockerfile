FROM node:20-bullseye

# Ses çalmak için gerekli paketleri (mpg123, alsa-utils ve pulseaudio) Linux'a kuruyoruz
RUN apt-get update && apt-get install -y mpg123 alsa-utils pulseaudio && rm -rf /var/lib/apt/lists/*

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
