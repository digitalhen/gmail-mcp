FROM node:20-slim

WORKDIR /app

# Install build dependencies and text extraction tools
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    poppler-utils \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

# Pre-download and exercise the embedding model during the image build.
# If the download is corrupt, the build fails here — nothing poisons
# the runtime cache, and every container starts with a verified model.
RUN node -e "import('@huggingface/transformers').then(m => m.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' })).then(p => p('warmup')).then(() => { console.log('Model preloaded OK'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });"

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

EXPOSE 3847

CMD ["node", "dist/server.js"]
