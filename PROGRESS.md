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

Status: IN PROGRESS
