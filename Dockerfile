# Node + FFmpeg. The jrottenberg image ships a full ffmpeg/ffprobe build, so we
# copy those binaries onto a slim Node base — no compiling, small image.
FROM jrottenberg/ffmpeg:6.1-ubuntu AS ffmpeg

FROM node:20-slim
# Bring in the ffmpeg + ffprobe binaries and the shared libs they need.
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg /usr/local/lib /usr/local/lib
RUN ldconfig

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
