# Node + FFmpeg, the simple reliable way: install ffmpeg from Debian. Its build
# includes libx264 + the native AAC encoder — everything our filter graphs need
# (overlay, scale, concat, amix, adelay, volume, trim).
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
