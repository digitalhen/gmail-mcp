# Gmail MCP Server

## Overview
A remote MCP server providing Gmail integration with semantic email search, LLM-driven enrichment, and a knowledge graph over emails, entities, and projects. Designed for use with claude.ai and other MCP clients. Supports multi-user OAuth.

## Architecture
- **Transport**: Streamable HTTP (Express 5) — runs as an HTTP server for remote MCP clients
- **MCP Auth**: OAuth 2.0 + PKCE (S256); dynamic client registration; access/refresh tokens stored in Postgres
- **Gmail Auth**: Google OAuth 2.0 per user; Google tokens stored in Postgres (not filesystem)
- **Vector DB**: PostgreSQL + pgvector, 384-dim embeddings (all-MiniLM-L6-v2 via `@huggingface/transformers`), HNSW index
- **Enrichment**: Claude Haiku via `@anthropic-ai/sdk` extracts intent, entities, projects, topics, sentiment
- **Session Management**: Per-session MCP transport with session IDs

## Key Files
- `src/server.ts` — MCP server, tool registrations, Express HTTP setup
- `src/auth.ts` — MCP OAuth + Google OAuth, token persistence, per-user isolation
- `src/db.ts` — Postgres connection pool
- `src/gmail-operations.ts` — Gmail API ops (send, read, reply, search, labels, attachments)
- `src/vector-store.ts` — pgvector embeddings + semantic search
- `src/indexing.ts` — Email indexing pipeline
- `src/enrichment.ts` — Claude-driven enrichment
- `src/projects.ts` — Project clustering, consolidation, orphan assignment
- `src/corrections.ts` — Manual corrections log
- `src/text-extraction.ts` — Attachment text extraction (pdf-parse, adm-zip)
- `src/temp-file-store.ts` — Temporary attachment handling

## Commands
- `npm run dev` — Run in development mode with tsx
- `npm run build` — Compile TypeScript to dist/
- `npm start` — Run compiled server
- `npm test` — Run test suite

## Setup Requirements
1. Create a Google Cloud project with Gmail API enabled
2. Create OAuth 2.0 credentials (Web Application type)
3. Add authorized redirect URI: `<BASE_URL>/google/callback`
4. Set env: `DATABASE_URL`, `PORT`, `BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ANTHROPIC_API_KEY`
5. `docker-compose up --build` brings up Postgres (with pgvector) + the server; migrations run on boot

## MCP Tools

### Account
- `gmail_whoami` — Authenticated Gmail account

### Email Operations
- `send_email` — Send new email (to, subject, body, cc, bcc)
- `create_draft` — Create a draft
- `get_recent_emails` — Fetch inbox with filters
- `get_email` — Get full email by ID
- `get_thread` — Get all messages in a thread
- `reply_to_email` — Reply preserving thread
- `search_emails` — Gmail search syntax
- `mark_as_read` / `mark_as_unread` — Toggle read status
- `trash_email` — Move to trash
- `get_labels` — List Gmail labels

### Attachments
- `list_attachments` — List attachments on a message
- `get_attachment` — Fetch attachment bytes
- `extract_attachment_text` — Server-side text extraction (PDF, zip-contained docs)

### Indexing & Semantic Search
- `gmail_index_emails` — Index emails into pgvector with pagination, auto-enrichment, promo filtering
- `gmail_semantic_search` — Natural-language search over embeddings
- `gmail_find_similar` — Find semantically similar emails
- `gmail_index_stats` — Index statistics

### AI Enrichment
- `gmail_enrich_emails` — Extract intent, entities, projects, topics, sentiment via Claude Haiku
- `gmail_get_unenriched` — Return emails lacking enrichment
- `gmail_write_enrichment` — Write an enrichment record (used by external enrichment workers)
- `gmail_enrich_stats` — Enrichment coverage and breakdown
- `gmail_reembed_enriched` — Re-embed emails using enriched metadata for better search

### Knowledge Graph
- `gmail_find_related` — 3-way search: project + entity + vector overlap
- `gmail_multi_hop` — Traverse entity connections across 1–3 hops
- `gmail_consolidate_entities` — AI-driven entity deduplication

### Project Management
- `gmail_list_projects` — All projects with stats
- `gmail_project_emails` — Emails in a project
- `gmail_project_summary` — AI-generated project narrative
- `gmail_consolidate_projects` — AI-driven merge of duplicate projects
- `gmail_assign_orphans` — Assign unprojected emails via entity overlap

### Corrections & Self-Improvement
- `gmail_assign_project` — Manually assign email to project
- `gmail_merge_projects` — Merge two projects
- `gmail_rename_project` — Rename a project
- `gmail_recluster` — Full cycle: consolidate + orphans + stale cleanup
- `gmail_enrichment_review` — Coverage stats and correction patterns
- `gmail_cleanup_promotionals` — Prune promotional mail from the index

## Database Schema
PostgreSQL with pgvector. Tables include:
- `oauth_clients` / `oauth_tokens` — MCP OAuth state; survives restarts
- `emails` — Indexed email metadata + 384-dim vector embeddings (HNSW)
- `email_enrichment` — AI-extracted intent, project, sentiment, type
- `entities` / `email_entities` — Named-entity graph
- `projects` / `email_projects` — Life-project clustering
- `email_tags` — Topic tags
- `enrichment_corrections` — Manual correction log

## Port
Default: 3847 (configurable via `PORT` env var)

## Deployment
- **Docker Compose** — `docker-compose up --build`
- **Railway** — `railway.toml` included; add Postgres plugin and set env vars

## Security
- OAuth 2.0 with PKCE (S256) for MCP authentication
- Google OAuth tokens stored in Postgres (not filesystem)
- Per-user data isolation
- Bearer tokens with 1-hour expiry and refresh rotation
- Parameterized SQL queries throughout
