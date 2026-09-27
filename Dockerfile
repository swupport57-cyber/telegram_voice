FROM node:20-slim

# ffmpeg for the audio/video conversion before sending.
# ca-certificates + openssl so any TLS handshakes from the Telegram client
# have a system trust store to verify against (the slim image ships empty).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      openssl \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "index.js"]
