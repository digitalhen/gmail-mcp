import * as lancedb from "@lancedb/lancedb";
import * as path from "path";

let pipelineFn: any;
let embeddingPipeline: any;

async function getEmbeddingPipeline() {
  if (embeddingPipeline) return embeddingPipeline;

  if (!pipelineFn) {
    const mod = await import("@huggingface/transformers");
    pipelineFn = mod.pipeline;
  }

  embeddingPipeline = await pipelineFn("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "fp32",
  });
  return embeddingPipeline;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const extractor = await getEmbeddingPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

interface EmailRecord {
  [key: string]: unknown;
  id: string;
  user_email: string;
  thread_id: string;
  subject: string;
  from_addr: string;
  to_addr: string;
  date: string;
  snippet: string;
  body_preview: string;
  vector: number[];
  indexed_at: string;
}

type SearchResult = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  bodyPreview: string;
  similarity: number;
};

const TABLE_NAME = "email_embeddings";

export class VectorDB {
  private dbPath: string;
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  constructor(dataDir: string) {
    this.dbPath = path.join(dataDir, "emails_lance");
  }

  private async getTable(): Promise<lancedb.Table> {
    if (this.table) return this.table;

    if (!this.db) {
      this.db = await lancedb.connect(this.dbPath);
    }

    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    }

    return this.table!;
  }

  private async getOrCreateTable(firstRecord: EmailRecord): Promise<lancedb.Table> {
    if (this.table) return this.table;

    if (!this.db) {
      this.db = await lancedb.connect(this.dbPath);
    }

    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      this.table = await this.db.createTable(TABLE_NAME, [firstRecord]);
    }

    return this.table;
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
    const textForEmbedding = [
      email.subject,
      email.snippet,
      email.body.substring(0, 1000),
    ]
      .filter(Boolean)
      .join(" ");

    const vector = await generateEmbedding(textForEmbedding);

    const record: EmailRecord = {
      id: email.id,
      user_email: userEmail,
      thread_id: email.threadId,
      subject: email.subject,
      from_addr: email.from,
      to_addr: email.to,
      date: email.date,
      snippet: email.snippet,
      body_preview: email.body.substring(0, 500),
      vector,
      indexed_at: new Date().toISOString(),
    };

    const table = await this.getOrCreateTable(record);

    // Check if this is the seed record (already inserted by createTable)
    const existing = await table.countRows(`id = '${email.id.replace(/'/g, "''")}'`);
    if (existing === 0) {
      await table.add([record]);
    }
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
    if (emails.length === 0) return { indexed: 0, skipped: 0 };

    let indexed = 0;
    let skipped = 0;

    // Batch: generate embeddings and collect new records
    const newRecords: EmailRecord[] = [];

    for (const email of emails) {
      // Check if already indexed
      const table = await this.getTable();
      if (table) {
        const exists = await table.countRows(`id = '${email.id.replace(/'/g, "''")}'`);
        if (exists > 0) {
          skipped++;
          continue;
        }
      }

      const textForEmbedding = [
        email.subject,
        email.snippet,
        email.body.substring(0, 1000),
      ]
        .filter(Boolean)
        .join(" ");

      const vector = await generateEmbedding(textForEmbedding);

      newRecords.push({
        id: email.id,
        user_email: userEmail,
        thread_id: email.threadId,
        subject: email.subject,
        from_addr: email.from,
        to_addr: email.to,
        date: email.date,
        snippet: email.snippet,
        body_preview: email.body.substring(0, 500),
        vector,
        indexed_at: new Date().toISOString(),
      });
      indexed++;
    }

    if (newRecords.length > 0) {
      const table = await this.getOrCreateTable(newRecords[0]);
      // If table was just created with first record, add the rest
      if (newRecords.length > 1) {
        await table.add(newRecords.slice(1));
      } else if (this.table) {
        // Table already existed, add all
        await table.add(newRecords);
      }
    }

    return { indexed, skipped };
  }

  async semanticSearch(
    userEmail: string,
    query: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const table = await this.getTable();
    if (!table) return [];

    const queryVector = await generateEmbedding(query);

    const results = await table
      .query()
      .nearestTo(queryVector)
      .where(`user_email = '${userEmail.replace(/'/g, "''")}'`)
      .distanceType("cosine")
      .limit(limit)
      .toArray();

    return results.map((r: any) => ({
      id: r.id,
      threadId: r.thread_id,
      subject: r.subject,
      from: r.from_addr,
      to: r.to_addr,
      date: r.date,
      snippet: r.snippet,
      bodyPreview: r.body_preview,
      // LanceDB cosine distance is 1 - similarity, so convert back
      similarity: 1 - (r._distance ?? 0),
    }));
  }

  async findSimilarEmails(
    userEmail: string,
    emailId: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const table = await this.getTable();
    if (!table) {
      throw new Error("No emails indexed yet. Run gmail_index_emails first.");
    }

    // Get the source email's vector
    const source = await table
      .query()
      .where(`id = '${emailId.replace(/'/g, "''")}'`)
      .limit(1)
      .toArray();

    if (source.length === 0) {
      throw new Error(
        `Email ${emailId} not found in index. Index it first using gmail_index_emails.`
      );
    }

    const sourceVector = source[0].vector;

    const results = await table
      .query()
      .nearestTo(sourceVector)
      .where(`user_email = '${userEmail.replace(/'/g, "''")}'`)
      .distanceType("cosine")
      .limit(limit + 1) // +1 because the source email will be in results
      .toArray();

    return results
      .filter((r: any) => r.id !== emailId)
      .slice(0, limit)
      .map((r: any) => ({
        id: r.id,
        threadId: r.thread_id,
        subject: r.subject,
        from: r.from_addr,
        to: r.to_addr,
        date: r.date,
        snippet: r.snippet,
        bodyPreview: r.body_preview,
        similarity: 1 - (r._distance ?? 0),
      }));
  }

  async getIndexStats(userEmail: string): Promise<{
    totalEmails: number;
    oldestEmail: string | null;
    newestEmail: string | null;
    lastIndexed: string | null;
  }> {
    const table = await this.getTable();
    if (!table) {
      return { totalEmails: 0, oldestEmail: null, newestEmail: null, lastIndexed: null };
    }

    const totalEmails = await table.countRows(
      `user_email = '${userEmail.replace(/'/g, "''")}'`
    );

    if (totalEmails === 0) {
      return { totalEmails: 0, oldestEmail: null, newestEmail: null, lastIndexed: null };
    }

    // Get date range
    const rows = await table
      .query()
      .where(`user_email = '${userEmail.replace(/'/g, "''")}'`)
      .select(["date", "indexed_at"])
      .toArray();

    const dates = rows.map((r: any) => r.date).filter(Boolean).sort();
    const indexDates = rows.map((r: any) => r.indexed_at).filter(Boolean).sort();

    return {
      totalEmails,
      oldestEmail: dates[0] || null,
      newestEmail: dates[dates.length - 1] || null,
      lastIndexed: indexDates[indexDates.length - 1] || null,
    };
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.table = null;
    }
  }
}
