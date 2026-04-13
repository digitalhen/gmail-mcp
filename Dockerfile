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

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

EXPOSE 3847

CMD ["node", "dist/server.js"]
