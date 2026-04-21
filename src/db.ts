import { Pool, PoolClient } from "pg";

class Database {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pool.on("error", (err) => {
      console.error("[DB] Unexpected pool error:", err);
    });
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await this.runMigrations(client);
      await this.cleanupExpiredTokens(client);
      console.log("[DB] Database initialized");
    } finally {
      client.release();
    }
  }

  async query(text: string, params?: any[]) {
    const start = Date.now();
    const result = await this.pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`[DB] Slow query (${duration}ms):`, text.slice(0, 100));
    }
    return result;
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createHnswIndexIfNeeded(): Promise<void> {
    await this.createHnswIfNonNull("embedding", "idx_emails_embedding");
    await this.createHnswIfNonNull("embedding_ollama", "idx_emails_embedding_ollama");
  }

  private async createHnswIfNonNull(column: string, indexName: string): Promise<void> {
    const nonNull = await this.query(
      `SELECT COUNT(*) as count FROM emails WHERE ${column} IS NOT NULL`
    );
    const count = parseInt(nonNull.rows[0].count);
    if (count === 0) return;

    const indexExists = await this.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = $1",
      [indexName]
    );
    if (indexExists.rows.length > 0) return;

    console.log(`[DB] Creating HNSW index ${indexName} on ${count} rows (${column})...`);
    await this.query(
      `CREATE INDEX ${indexName} ON emails USING hnsw (${column} vector_cosine_ops) WITH (m = 16, ef_construction = 64)`
    );
    console.log(`[DB] HNSW index ${indexName} created`);
  }

  private async cleanupExpiredTokens(client: PoolClient): Promise<void> {
    const result = await client.query(
      "DELETE FROM oauth_tokens WHERE token_type = 'access' AND expires_at < NOW()"
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[DB] Cleaned up ${result.rowCount} expired access tokens`);
    }
    // Clean up stale pending auths and auth codes (older than 10 minutes)
    await client.query(
      "DELETE FROM oauth_pending_auths WHERE created_at < NOW() - INTERVAL '10 minutes'"
    );
    await client.query(
      "DELETE FROM oauth_auth_codes WHERE created_at < NOW() - INTERVAL '10 minutes'"
    );
  }

  private async runMigrations(client: PoolClient): Promise<void> {
    await client.query(`
      -- ============================================================
      -- OAuth State
      -- ============================================================

      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret TEXT,
        client_name TEXT,
        redirect_uris TEXT[],
        grant_types TEXT[],
        response_types TEXT[],
        token_endpoint_auth_method TEXT,
        client_id_issued_at BIGINT,
        client_secret_expires_at BIGINT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token TEXT PRIMARY KEY,
        token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
        client_id TEXT REFERENCES oauth_clients(client_id),
        user_email TEXT NOT NULL,
        google_access_token TEXT,
        google_refresh_token TEXT,
        google_expiry_date BIGINT,
        scopes TEXT[],
        expires_at TIMESTAMPTZ,
        related_token TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tokens_email ON oauth_tokens(user_email);
      CREATE INDEX IF NOT EXISTS idx_tokens_type ON oauth_tokens(token_type);
      CREATE INDEX IF NOT EXISTS idx_tokens_expires ON oauth_tokens(expires_at) WHERE token_type = 'access';

      -- ============================================================
      -- Email Index
      -- ============================================================

      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        thread_id TEXT,
        subject TEXT,
        from_addr TEXT,
        to_addr TEXT,
        date TEXT,
        snippet TEXT,
        body_preview TEXT,
        body_hash TEXT,
        embedding vector(384),
        indexed_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_email);
      CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
      CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(user_email, date DESC);
      CREATE INDEX IF NOT EXISTS idx_emails_body_hash ON emails(body_hash);

      -- ============================================================
      -- Knowledge Graph
      -- ============================================================

      CREATE TABLE IF NOT EXISTS email_enrichment (
        email_id TEXT PRIMARY KEY REFERENCES emails(id),
        intent_summary TEXT,
        life_project TEXT,
        sentiment TEXT,
        email_type TEXT,
        is_transactional BOOLEAN DEFAULT FALSE,
        is_promotional BOOLEAN DEFAULT FALSE,
        enriched_at TIMESTAMPTZ DEFAULT NOW(),
        enrichment_model TEXT,
        embedding_enriched BOOLEAN DEFAULT FALSE
      );

      CREATE INDEX IF NOT EXISTS idx_enrichment_project ON email_enrichment(life_project);

      CREATE TABLE IF NOT EXISTS entities (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        UNIQUE(canonical_name, entity_type)
      );

      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
      CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_name);

      CREATE TABLE IF NOT EXISTS email_entities (
        email_id TEXT NOT NULL REFERENCES emails(id),
        entity_id INTEGER NOT NULL REFERENCES entities(id),
        role TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        PRIMARY KEY (email_id, entity_id, role)
      );

      CREATE INDEX IF NOT EXISTS idx_email_entities_entity ON email_entities(entity_id);
      CREATE INDEX IF NOT EXISTS idx_email_entities_email ON email_entities(email_id);

      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'active',
        first_seen TIMESTAMPTZ,
        last_activity TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS email_projects (
        email_id TEXT NOT NULL REFERENCES emails(id),
        project_id INTEGER NOT NULL REFERENCES projects(id),
        confidence REAL DEFAULT 1.0,
        assigned_by TEXT DEFAULT 'llm',
        PRIMARY KEY (email_id, project_id)
      );

      CREATE INDEX IF NOT EXISTS idx_email_projects_project ON email_projects(project_id);

      CREATE TABLE IF NOT EXISTS email_tags (
        email_id TEXT NOT NULL REFERENCES emails(id),
        tag TEXT NOT NULL,
        PRIMARY KEY (email_id, tag)
      );

      CREATE INDEX IF NOT EXISTS idx_email_tags_tag ON email_tags(tag);

      CREATE TABLE IF NOT EXISTS enrichment_corrections (
        id SERIAL PRIMARY KEY,
        email_id TEXT,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        corrected_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS email_dates (
        email_id TEXT REFERENCES emails(id),
        date TEXT NOT NULL,
        description TEXT,
        PRIMARY KEY (email_id, date)
      );

      CREATE TABLE IF NOT EXISTS oauth_pending_auths (
        google_state TEXT PRIMARY KEY,
        mcp_client_id TEXT NOT NULL,
        mcp_redirect_uri TEXT NOT NULL,
        mcp_state TEXT,
        mcp_code_challenge TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS oauth_auth_codes (
        code TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        google_access_token TEXT,
        google_refresh_token TEXT,
        google_expiry_date BIGINT,
        code_challenge TEXT NOT NULL,
        client_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- New columns (idempotent with DO NOTHING on error)
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS body_full TEXT;
      ALTER TABLE email_enrichment ADD COLUMN IF NOT EXISTS enrichment_raw JSONB;
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_promotional BOOLEAN DEFAULT FALSE;

      -- Ollama-provided embeddings (768-dim, e.g. nomic-embed-text).
      -- Coexists with the original 384-dim column so we can flip providers
      -- via the EMBEDDING_PROVIDER flag without losing the other index.
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS embedding_ollama vector(768);

      -- Keyword search column for hybrid retrieval. Generated from
      -- subject + snippet only (body_preview contains HTML tags that
      -- would pollute the lexicon).
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS search_text tsvector
        GENERATED ALWAYS AS (
          to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(snippet, ''))
        ) STORED;
      CREATE INDEX IF NOT EXISTS idx_emails_search_text ON emails USING GIN (search_text);
    `);
  }
}

export const db = new Database();
