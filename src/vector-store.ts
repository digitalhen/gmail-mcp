import { db } from "./db.js";
import { createHash } from "crypto";
import { stripHtml } from "./enrichment.js";

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

export async function generateEmbedding(text: string): Promise<number[]> {
  const extractor = await getEmbeddingPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
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
  const embedding = await generateEmbedding(text);

  const vectorStr = `[${embedding.join(",")}]`;

  await db.query(
    `INSERT INTO emails (id, user_email, thread_id, subject, from_addr, to_addr, date, snippet, body_preview, body_full, body_hash, embedding)
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
  const embedding = await generateEmbedding(queryText);
  const vectorStr = `[${embedding.join(",")}]`;

  const result = await db.query(
    `SELECT id, thread_id, subject, from_addr, to_addr, date, snippet, body_preview,
            1 - (embedding <=> $1::vector) as similarity
     FROM emails
     WHERE user_email = $2
     ORDER BY embedding <=> $1::vector
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
  // Get the source email's vector
  const source = await db.query("SELECT embedding FROM emails WHERE id = $1", [
    emailId,
  ]);
  if (source.rows.length === 0)
    throw new Error(
      `Email ${emailId} not found in index. Index it first using gmail_index_emails.`
    );

  const result = await db.query(
    `SELECT id, thread_id, subject, from_addr, to_addr, date, snippet, body_preview,
            1 - (embedding <=> $1::vector) as similarity
     FROM emails
     WHERE user_email = $2 AND id != $3
     ORDER BY embedding <=> $1::vector
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
