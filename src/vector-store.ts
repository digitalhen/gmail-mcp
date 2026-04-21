import { db } from "./db.js";
import { createHash } from "crypto";
import { stripHtml } from "./enrichment.js";

type Provider = "transformers" | "ollama";

export function activeProvider(): Provider {
  const p = (process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase();
  return p === "ollama" ? "ollama" : "transformers";
}

export function activeEmbeddingColumn(): "embedding" | "embedding_ollama" {
  return activeProvider() === "ollama" ? "embedding_ollama" : "embedding";
}

let pipelineFn: any;
let embeddingPipeline: any;

async function getEmbeddingPipeline() {
  if (embeddingPipeline) return embeddingPipeline;

  if (!pipelineFn) {
    const mod = await import("@huggingface/transformers");
    pipelineFn = mod.pipeline;
  }

  embeddingPipeline = await pipelineFn(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2",
    { dtype: "fp32" }
  );
  return embeddingPipeline;
}

async function embedTransformers(text: string): Promise<number[]> {
  const extractor = await getEmbeddingPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

async function embedOllama(text: string, role: "query" | "document"): Promise<number[]> {
  const base = (process.env.OLLAMA_URL || "http://host.docker.internal:11434").replace(/\/+$/, "");
  const model = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
  // nomic-embed-text is trained with task prefixes — without them, retrieval
  // quality collapses to noise. Other models may not need this, so only
  // prefix if the model name matches.
  const needsPrefix = model.includes("nomic-embed");
  const input = needsPrefix
    ? `${role === "query" ? "search_query" : "search_document"}: ${text}`
    : text;
  const res = await fetch(`${base}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama embed ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { embeddings?: number[][]; embedding?: number[] };
  const vec = data.embeddings?.[0] || data.embedding;
  if (!vec || !Array.isArray(vec)) {
    throw new Error("Ollama embed: empty or malformed response");
  }
  // Normalize to unit length so cosine distance matches our MiniLM setup.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

export async function generateEmbedding(
  text: string,
  role: "query" | "document" = "document"
): Promise<number[]> {
  return activeProvider() === "ollama"
    ? embedOllama(text, role)
    : embedTransformers(text);
}

export function computeBodyHash(
  from: string,
  subject: string,
  body: string
): string {
  return createHash("sha256")
    .update(`${from}|${subject}|${body.slice(0, 200)}`)
    .digest("hex");
}

export async function indexEmail(record: {
  id: string;
  userEmail: string;
  threadId: string;
  subject: string;
  fromAddr: string;
  toAddr: string;
  date: string;
  snippet: string;
  bodyPreview: string;
  bodyFull: string;
  bodyHash: string;
}): Promise<boolean> {
  // Check dedup by id
  const existing = await db.query("SELECT 1 FROM emails WHERE id = $1", [
    record.id,
  ]);
  if (existing.rows.length > 0) return false;

  // Check dedup by body hash
  if (record.bodyHash) {
    const hashExists = await db.query(
      "SELECT 1 FROM emails WHERE body_hash = $1 AND user_email = $2",
      [record.bodyHash, record.userEmail]
    );
    if (hashExists.rows.length > 0) return false;
  }

  // Strip HTML and generate embedding on clean text
  const cleanBody = stripHtml(record.bodyPreview);
  const text = `${record.subject} ${record.snippet} ${cleanBody.slice(0, 1000)}`;
  const embedding = await generateEmbedding(text, "document");
  const vectorStr = `[${embedding.join(",")}]`;
  const col = activeEmbeddingColumn();

  await db.query(
    `INSERT INTO emails (id, user_email, thread_id, subject, from_addr, to_addr, date, snippet, body_preview, body_full, body_hash, ${col})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO NOTHING`,
    [
      record.id,
      record.userEmail,
      record.threadId,
      record.subject,
      record.fromAddr,
      record.toAddr,
      record.date,
      record.snippet,
      record.bodyPreview,
      record.bodyFull,
      record.bodyHash,
      vectorStr,
    ]
  );

  return true;
}

export async function indexEmails(
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
    const bodyHash = computeBodyHash(email.from, email.subject, email.body);
    const wasIndexed = await indexEmail({
      id: email.id,
      userEmail,
      threadId: email.threadId,
      subject: email.subject,
      fromAddr: email.from,
      toAddr: email.to,
      date: email.date,
      snippet: email.snippet,
      bodyPreview: email.body.substring(0, 2000),
      bodyFull: email.body,
      bodyHash,
    });

    if (wasIndexed) {
      indexed++;
    } else {
      skipped++;
    }
  }

  return { indexed, skipped };
}

export async function semanticSearch(
  queryText: string,
  userEmail: string,
  limit: number
): Promise<any[]> {
  const embedding = await generateEmbedding(queryText, "query");
  const vectorStr = `[${embedding.join(",")}]`;
  const col = activeEmbeddingColumn();

  const result = await db.query(
    `SELECT id, thread_id, subject, from_addr, to_addr, date, snippet, body_preview,
            1 - (${col} <=> $1::vector) as similarity
     FROM emails
     WHERE user_email = $2 AND ${col} IS NOT NULL
     ORDER BY ${col} <=> $1::vector
     LIMIT $3`,
    [vectorStr, userEmail, limit]
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    threadId: r.thread_id,
    subject: r.subject,
    from: r.from_addr,
    to: r.to_addr,
    date: r.date,
    snippet: r.snippet,
    bodyPreview: r.body_preview,
    similarity: parseFloat(r.similarity),
  }));
}

export async function findSimilar(
  emailId: string,
  userEmail: string,
  limit: number
): Promise<any[]> {
  const col = activeEmbeddingColumn();
  // Get the source email's vector for the active provider.
  const source = await db.query(
    `SELECT ${col} as embedding FROM emails WHERE id = $1`,
    [emailId]
  );
  if (source.rows.length === 0 || !source.rows[0].embedding)
    throw new Error(
      `Email ${emailId} not indexed for provider ${activeProvider()}. Run /reembed first.`
    );

  const result = await db.query(
    `SELECT id, thread_id, subject, from_addr, to_addr, date, snippet, body_preview,
            1 - (${col} <=> $1::vector) as similarity
     FROM emails
     WHERE user_email = $2 AND id != $3 AND ${col} IS NOT NULL
     ORDER BY ${col} <=> $1::vector
     LIMIT $4`,
    [source.rows[0].embedding, userEmail, emailId, limit]
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    threadId: r.thread_id,
    subject: r.subject,
    from: r.from_addr,
    to: r.to_addr,
    date: r.date,
    snippet: r.snippet,
    bodyPreview: r.body_preview,
    similarity: parseFloat(r.similarity),
  }));
}

export async function getIndexStats(userEmail: string) {
  const total = await db.query(
    "SELECT COUNT(*) as count FROM emails WHERE user_email = $1",
    [userEmail]
  );
  const dateRows = await db.query(
    "SELECT date FROM emails WHERE user_email = $1 AND date IS NOT NULL",
    [userEmail]
  );
  let oldestDate: string | null = null;
  let newestDate: string | null = null;
  let oldestTs = Infinity;
  let newestTs = -Infinity;
  for (const row of dateRows.rows) {
    const ts = new Date(row.date).getTime();
    if (isNaN(ts)) continue;
    if (ts < oldestTs) { oldestTs = ts; oldestDate = row.date; }
    if (ts > newestTs) { newestTs = ts; newestDate = row.date; }
  }
  const lastIndexed = await db.query(
    "SELECT indexed_at FROM emails WHERE user_email = $1 ORDER BY indexed_at DESC LIMIT 1",
    [userEmail]
  );

  return {
    totalEmails: parseInt(total.rows[0].count),
    oldestEmail: oldestDate,
    newestEmail: newestDate,
    lastIndexed: lastIndexed.rows[0]?.indexed_at || null,
  };
}
