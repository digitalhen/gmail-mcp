# Gmail MCP Server

## Overview
A remote MCP server providing Gmail integration with semantic email search via vector embeddings. Designed for use with claude.ai and other MCP clients. Supports multi-user OAuth authentication.

## Architecture
- **Transport**: Streamable HTTP (not stdio) — runs as an HTTP server for remote MCP clients
- **Auth**: Google OAuth 2.0 per user, tokens stored in `~/.gmail-mcp/`
- **Vector DB**: SQLite + local embeddings (all-MiniLM-L6-v2 via @huggingface/transformers)
- **Session Management**: Per-session MCP transport with session IDs

## Key Files
- `src/server.ts` — Main MCP server with all tool definitions and Express HTTP setup
- `src/auth.ts` — OAuth 2.0 flow, token management, multi-account session registry
- `src/gmail-operations.ts` — Gmail API operations (send, read, reply, search, labels)
- `src/vector-db.ts` — SQLite vector store with local embeddings for semantic search

## Commands
- `npm run dev` — Run in development mode with tsx
- `npm run build` — Compile TypeScript to dist/
- `npm start` — Run compiled server
- `npm test` — Run test suite

## Setup Requirements
1. Create a Google Cloud project with Gmail API enabled
2. Create OAuth 2.0 credentials (Desktop App type)
3. Download credentials.json to `~/.gmail-mcp/credentials.json`
4. Run the server and use `gmail_authenticate` tool to start OAuth flow

## MCP Tools
### Authentication
- `gmail_authenticate` — Start OAuth flow
- `gmail_check_auth` — Check auth status
- `gmail_list_accounts` — List authenticated accounts
- `gmail_switch_account` — Switch active account

### Email Operations
- `send_email` — Send new email (to, subject, body, cc, bcc)
- `get_recent_emails` — Fetch inbox with filters
- `get_email` — Get full email by ID
- `get_thread` — Get all messages in a thread
- `reply_to_email` — Reply preserving thread
- `search_emails` — Gmail search syntax
- `mark_as_read` / `mark_as_unread` — Toggle read status
- `trash_email` — Move to trash
- `get_labels` — List Gmail labels

### Semantic Search
- `gmail_index_emails` — Index emails into vector DB
- `gmail_semantic_search` — Natural language email search
- `gmail_find_similar` — Find semantically similar emails
- `gmail_index_stats` — Vector index statistics

## Data Storage
All data stored in `~/.gmail-mcp/`:
- `credentials.json` — Google OAuth credentials (user-provided)
- `{email}_token.json` — Per-account OAuth tokens
- `session_registry.json` — Account registry
- `emails_vector.db` — SQLite vector database

## Port
Default: 3847 (configurable via PORT env var)
