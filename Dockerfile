FROM node:20-slim

# ffmpeg is required for the OGG/Opus conversion before sending.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so Docker can cache this layer.
COPY package.json ./
RUN npm install --omit=dev

# Then the source.
COPY index.js ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.js"]
