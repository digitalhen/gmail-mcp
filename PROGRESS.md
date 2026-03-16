# Gmail MCP Knowledge Graph -- Progress Log

## Codebase Analysis

### Project Structure
- **Framework**: Express 5 + `@modelcontextprotocol/sdk` (Streamable HTTP transport)
- **Entry point**: `src/server.ts` — Express app on port 3847, MCP tools, OAuth middleware
- **4 source files**: server.ts, auth.ts, gmail-operations.ts, vector-db.ts

### Tool Registration Pattern
Tools registered via `server.tool(name, description, zodSchema, handler)` inside `createServer()`. Each handler receives `(args, extra)` where `extra.authInfo` carries the authenticated user's bearer token and email. Two helpers extract context:
- `getGmailFromExtra(extra)` — bearer token → Google OAuth2 client + Gmail service
- `getEmailFromExtra(extra)` — reads `extra.authInfo.extra.email`

All handlers follow: try/catch → success returns `{ content: [{ type: "text", text: JSON.stringify(...) }] }`, errors return `{ content: [...], isError: true }`.

16 tools total: gmail_whoami, send_email, get_recent_emails, get_email, get_thread, reply_to_email, search_emails, mark_as_read, mark_as_unread, trash_email, get_labels, gmail_index_emails, gmail_semantic_search, gmail_find_similar, gmail_index_stats.

### Auth Flow (Double OAuth)
`GmailOAuthProvider` implements MCP SDK's `OAuthServerProvider`. Bridges MCP OAuth → Google OAuth:
1. claude.ai discovers endpoints via `/.well-known/oauth-authorization-server`
2. Dynamic client registration via `/register`
3. `/authorize` → redirects to Google OAuth consent
4. Google callback `/google/callback` → exchanges Google code for tokens, generates MCP auth code
5. `/token` → exchanges MCP auth code for bearer + refresh tokens
6. Bearer token used on all `/mcp` requests, looked up via `verifyAccessToken()`

**Current state problems**: All OAuth state in in-memory Maps — lost on restart. Google tokens in filesystem JSON files.

### Gmail Operations (gmail-operations.ts)
Stateless wrappers around Gmail API v1. **Will not be modified.** Handles: send, read, reply (with thread preservation via In-Reply-To/References headers), search (Gmail query syntax), labels, trash, mark read/unread. Messages fetched one-at-a-time via `messages.get(format: "full")`.

### Vector DB (vector-db.ts)
LanceDB at `~/.gmail-mcp/emails_lance/`. Embeddings from `Xenova/all-MiniLM-L6-v2` (384-dim, local, no API). Single table `email_embeddings` with: id, user_email, thread_id, subject, from_addr, to_addr, date, snippet, body_preview, vector, indexed_at. Search via `.nearestTo(vector).where(user_email).distanceType("cosine")`.

**Will be replaced** with PostgreSQL + pgvector.

---

## Sprint 0: Docker + PostgreSQL Foundation

Status: COMPLETE

### What was built
- Docker Compose with pgvector/pgvector:pg16 (port 5433 locally, 5432 internally)
- Dockerfile for containerized deployment
- `src/db.ts` — PostgreSQL connection pool (max 20), migrations, HNSW index creation, token cleanup
- `src/vector-store.ts` — pgvector-backed vector store replacing LanceDB, same embedding model (Xenova/all-MiniLM-L6-v2, 384-dim)
- `src/auth.ts` — Rewritten to use Postgres for oauth_clients and oauth_tokens. pendingAuths/authCodes remain in-memory (short-lived). Removed all filesystem JSON operations.
- `src/server.ts` — Updated startup sequence (db.initialize → createHnswIndex → Express), request logging middleware, health check includes DB status
- Full schema: 10 tables (oauth_clients, oauth_tokens, emails, email_enrichment, entities, email_entities, projects, email_projects, email_tags, enrichment_corrections)
- Google credentials now read from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars instead of credentials.json file

### What worked
- All migrations idempotent (IF NOT EXISTS)
- OAuth client registration persists to Postgres
- 401 on unauthenticated MCP requests
- Health endpoint checks DB connectivity
- Clean TypeScript build

### Files created/modified
- Created: docker-compose.yml, Dockerfile, .dockerignore, .env, src/db.ts, src/vector-store.ts
- Modified: src/auth.ts, src/server.ts, .gitignore, package.json
- Deleted: src/vector-db.ts, src/test.ts

---

## Sprint 1: Enrichment Pipeline

Status: COMPLETE

### What was built
- `src/enrichment.ts` — Enrichment module using Claude Haiku (claude-haiku-4-5-20251001)
  - Uses the exact enrichment prompt from the spec
  - Parses JSON response (strips markdown fences if present)
  - Writes to Postgres in a transaction: email_enrichment, entities, email_entities, email_tags, projects, email_projects
  - `getEnrichmentStats()` — SQL queries for projects, entities, tags, sentiment breakdown
- Two new MCP tools in server.ts:
  - `gmail_enrich_emails` — Finds unenriched indexed emails, calls Haiku with 200ms delays, fetches full body from Gmail if body_preview < 200 chars
  - `gmail_enrich_stats` — Returns enrichment statistics

### Files created/modified
- Created: src/enrichment.ts
- Modified: src/server.ts (added enrichment tools + import)

---

## Sprint 2: Entity-Aware Search

Status: COMPLETE

### What was built
- `gmail_reembed_enriched` — Re-embeds enriched emails with richer text (subject + from + intent + project + topics + entities + body). Updates the embedding column and sets embedding_enriched = true.
- `gmail_find_related` — 3-way search combining project overlap (0.4 weight), entity overlap (0.35 weight, requires 2+ shared entities), and vector similarity (0.25 weight). Returns results with match_reasons explaining why each email matched.
- `gmail_multi_hop` — Multi-hop entity traversal. Each hop finds emails sharing 2+ entities with previous results. Tracks seen IDs to avoid cycles. Returns grouped by hop with discovered entity chains.
- Exported `generateEmbedding` from vector-store.ts for reuse in reembed tool.

### Files modified
- src/server.ts (3 new tools)
- src/vector-store.ts (export generateEmbedding)

---

## Sprint 3: Project Clustering

Status: COMPLETE

### What was built
- `src/projects.ts` — Project management module:
  - `consolidateProjects()` — Sends project list to Haiku for merge suggestions, applies merges in a transaction
  - `applyProjectMerge()` — Moves email_projects links, deletes source projects
  - `assignOrphans()` — Finds enriched emails with no project, assigns via entity overlap (2+ shared entities)
  - `listProjects()` / `projectEmails()` / `projectSummary()` — Queries and Haiku-generated narrative
- 5 new MCP tools: `gmail_consolidate_projects`, `gmail_assign_orphans`, `gmail_list_projects`, `gmail_project_emails`, `gmail_project_summary`

### Files created/modified
- Created: src/projects.ts
- Modified: src/server.ts (5 new tools + import)

---

## Sprint 4: Self-Improvement + Corrections

Status: COMPLETE

### What was built
- `src/corrections.ts` — Correction and self-improvement module:
  - `assignProject()` — Manual project assignment with correction logging
  - `mergeProjects()` / `renameProject()` — Project management with correction logging
  - `recluster()` — Full cycle: consolidate → assign orphans → mark stale projects completed (60 days inactive)
  - `enrichmentReview()` — Coverage stats, correction counts by type, recent corrections
- 5 new MCP tools: `gmail_assign_project`, `gmail_merge_projects`, `gmail_rename_project`, `gmail_recluster`, `gmail_enrichment_review`

### Files created/modified
- Created: src/corrections.ts
- Modified: src/server.ts (5 new tools + import)

---

## Sprint 5: Indexing Improvements

Status: IN PROGRESS
