import crypto from "crypto";

interface StoredFile {
  data: Buffer;
  filename: string;
  mimeType: string;
  createdAt: number;
}

export class TempFileStore {
  private store = new Map<string, StoredFile>();
  private ttlSeconds: number;
  private maxFileSize: number;

  constructor(ttlSeconds = 900, maxFileSize = 25 * 1024 * 1024) {
    this.ttlSeconds = ttlSeconds;
    this.maxFileSize = maxFileSize;
  }

  /** Store file bytes, return a random token. */
  store_file(data: Buffer, filename: string, mimeType: string): string {
    this.cleanup();
    if (data.length > this.maxFileSize) {
      throw new Error(`File exceeds max size of ${this.maxFileSize} bytes`);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    this.store.set(token, {
      data,
      filename,
      mimeType,
      createdAt: Date.now(),
    });
    return token;
  }

  /** Retrieve file by token. Returns undefined if expired or not found. */
  retrieve(token: string): StoredFile | undefined {
    this.cleanup();
    return this.store.get(token);
  }

  /** Remove expired entries. */
  private cleanup() {
    const now = Date.now();
    const ttlMs = this.ttlSeconds * 1000;
    for (const [key, entry] of this.store) {
      if (now - entry.createdAt > ttlMs) {
        this.store.delete(key);
      }
    }
  }
}
