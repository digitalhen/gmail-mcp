import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

let pipeline: any;
let embeddingPipeline: any;

async function getEmbeddingPipeline() {
  if (embeddingPipeline) return embeddingPipeline;

  if (!pipeline) {
    const mod = await import("@huggingface/transformers");
    pipeline = mod.pipeline;
  }

  embeddingPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "fp32",
  });
  return embeddingPipeline;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const extractor = await getEmbeddingPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class VectorDB {
  private db: Database.Database;

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, "emails_vector.db");
    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_embeddings (
        id TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        thread_id TEXT,
        subject TEXT,
        from_addr TEXT,
        to_addr TEXT,
        date TEXT,
        snippet TEXT,
        body_preview TEXT,
        embedding BLOB NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_email_user ON email_embeddings(user_email);
      CREATE INDEX IF NOT EXISTS idx_email_thread ON email_embeddings(thread_id);
      CREATE INDEX IF NOT EXISTS idx_email_date ON email_embeddings(date);
    `);
  }

  async indexEmail(
    userEmail: string,
    email: {
      id: string;
      threadId: string;
      subject: string;
      from: string;
      to: string;
      date: string;
      snippet: string;
      body: string;
    }
  ): Promise<void> {
    // Create text for embedding: combine subject, snippet, and body preview
    const textForEmbedding = [
      email.subject,
      email.snippet,
      email.body.substring(0, 1000),
    ]
      .filter(Boolean)
      .join(" ");

    const embedding = await generateEmbedding(textForEmbedding);
    const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO email_embeddings
         (id, user_email, thread_id, subject, from_addr, to_addr, date, snippet, body_preview, embedding, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        email.id,
        userEmail,
        email.threadId,
        email.subject,
        email.from,
        email.to,
        email.date,
        email.snippet,
        email.body.substring(0, 500),
        embeddingBlob,
        new Date().toISOString()
      );
  }

  async indexEmails(
    userEmail: string,
    emails: Array<{
      id: string;
      threadId: string;
      subject: string;
      from: string;
      to: string;
      date: string;
      snippet: string;
      body: string;
    }>
  ): Promise<{ indexed: number; skipped: number }> {
    let indexed = 0;
    let skipped = 0;

    for (const email of emails) {
      // Skip if already indexed
      const existing = this.db
        .prepare("SELECT id FROM email_embeddings WHERE id = ?")
        .get(email.id);
      if (existing) {
        skipped++;
        continue;
      }
      await this.indexEmail(userEmail, email);
      indexed++;
    }

    return { indexed, skipped };
  }

  async semanticSearch(
    userEmail: string,
    query: string,
    limit: number = 10
  ): Promise<
    Array<{
      id: string;
      threadId: string;
      subject: string;
      from: string;
      to: string;
      date: string;
      snippet: string;
      bodyPreview: string;
      similarity: number;
    }>
  > {
    const queryEmbedding = await generateEmbedding(query);

    // Get all embeddings for this user
    const rows = this.db
      .prepare(
        "SELECT id, thread_id, subject, from_addr, to_addr, date, snippet, body_preview, embedding FROM email_embeddings WHERE user_email = ?"
      )
      .all(userEmail) as Array<{
      id: string;
      thread_id: string;
      subject: string;
      from_addr: string;
      to_addr: string;
      date: string;
      snippet: string;
      body_preview: string;
      embedding: Buffer;
    }>;

    // Compute similarities
    const results = rows.map((row) => {
      const embedding = Array.from(
        new Float32Array(
          row.embedding.buffer.slice(
            row.embedding.byteOffset,
            row.embedding.byteOffset + row.embedding.byteLength
          )
        )
      );
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      return {
        id: row.id,
        threadId: row.thread_id,
        subject: row.subject,
        from: row.from_addr,
        to: row.to_addr,
        date: row.date,
        snippet: row.snippet,
        bodyPreview: row.body_preview,
        similarity,
      };
    });

    // Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  async findSimilarEmails(
    userEmail: string,
    emailId: string,
    limit: number = 10
  ): Promise<
    Array<{
      id: string;
      threadId: string;
      subject: string;
      from: string;
      to: string;
      date: string;
      snippet: string;
      bodyPreview: string;
      similarity: number;
    }>
  > {
    // Get the source email's embedding
    const source = this.db
      .prepare(
        "SELECT embedding FROM email_embeddings WHERE id = ? AND user_email = ?"
      )
      .get(emailId, userEmail) as { embedding: Buffer } | undefined;

    if (!source) {
      throw new Error(
        `Email ${emailId} not found in index. Index it first using gmail_index_emails.`
      );
    }

    const sourceEmbedding = Array.from(
      new Float32Array(
        source.embedding.buffer.slice(
          source.embedding.byteOffset,
          source.embedding.byteOffset + source.embedding.byteLength
        )
      )
    );

    // Get all other embeddings for this user
    const rows = this.db
      .prepare(
        "SELECT id, thread_id, subject, from_addr, to_addr, date, snippet, body_preview, embedding FROM email_embeddings WHERE user_email = ? AND id != ?"
      )
      .all(userEmail, emailId) as Array<{
      id: string;
      thread_id: string;
      subject: string;
      from_addr: string;
      to_addr: string;
      date: string;
      snippet: string;
      body_preview: string;
      embedding: Buffer;
    }>;

    const results = rows.map((row) => {
      const embedding = Array.from(
        new Float32Array(
          row.embedding.buffer.slice(
            row.embedding.byteOffset,
            row.embedding.byteOffset + row.embedding.byteLength
          )
        )
      );
      const similarity = cosineSimilarity(sourceEmbedding, embedding);
      return {
        id: row.id,
        threadId: row.thread_id,
        subject: row.subject,
        from: row.from_addr,
        to: row.to_addr,
        date: row.date,
        snippet: row.snippet,
        bodyPreview: row.body_preview,
        similarity,
      };
    });

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  getIndexStats(userEmail: string): {
    totalEmails: number;
    oldestEmail: string | null;
    newestEmail: string | null;
    lastIndexed: string | null;
  } {
    const count = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM email_embeddings WHERE user_email = ?"
      )
      .get(userEmail) as { count: number };

    const oldest = this.db
      .prepare(
        "SELECT MIN(date) as date FROM email_embeddings WHERE user_email = ?"
      )
      .get(userEmail) as { date: string | null };

    const newest = this.db
      .prepare(
        "SELECT MAX(date) as date FROM email_embeddings WHERE user_email = ?"
      )
      .get(userEmail) as { date: string | null };

    const lastIndexed = this.db
      .prepare(
        "SELECT MAX(indexed_at) as indexed_at FROM email_embeddings WHERE user_email = ?"
      )
      .get(userEmail) as { indexed_at: string | null };

    return {
      totalEmails: count.count,
      oldestEmail: oldest.date,
      newestEmail: newest.date,
      lastIndexed: lastIndexed.indexed_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
