# Gmail MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that connects AI assistants to Gmail. Authenticate with Google, read and send emails, and search your inbox using natural language — all through claude.ai or any MCP-compatible client.

Includes a built-in vector database for semantic email search: find emails by meaning, not just keywords. Searching for "phone calls" will surface emails about FaceTime, Zoom, "give me a ring", etc.

## Features

- **OAuth integration** — Users authenticate with Google directly when adding the MCP server. No passwords stored, tokens auto-refresh.
- **Multi-user** — Each user gets isolated Gmail access via their own OAuth tokens. Multiple people can use the same server.
- **Full Gmail operations** — Send, read, reply, search, label, trash.
- **Semantic search** — Local vector embeddings (all-MiniLM-L6-v2) index your emails for natural language search.
- **Thread continuity** — Replies preserve Gmail thread context with proper `In-Reply-To` and `References` headers.
- **Remote-first** — Runs as an HTTP server with Streamable HTTP transport, designed for claude.ai and remote MCP clients.

## Setup

### 1. Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Enable the **Gmail API**: APIs & Services → Library → search "Gmail API" → Enable
4. Configure the **OAuth consent screen**: APIs & Services → OAuth consent screen
   - Choose **External**
   - App name: `Gmail MCP` (or whatever you like)
   - Add your email as a test user
   - Add scopes: `gmail.send`, `gmail.readonly`, `gmail.compose`, `gmail.modify`
5. Create **OAuth credentials**: APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Authorized redirect URIs: `http://localhost:3847/google/callback`
   - If using ngrok/tunnel: also add `https://<your-domain>/google/callback`
6. Download the credentials JSON

### 2. Install and Configure

```bash
git clone <repo-url> gmail-mcp
cd gmail-mcp
npm install
```

Place your Google credentials:

```bash
cp ~/Downloads/client_secret_*.json ~/.gmail-mcp/credentials.json
```

### 3. Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

The server starts on port 3847 by default.

### 4. Expose Publicly (for claude.ai)

The server needs to be reachable over HTTPS for claude.ai. Use ngrok or any reverse proxy:

```bash
ngrok http 3847
```

Then set `BASE_URL` to the public URL:

```bash
BASE_URL=https://your-domain.ngrok-free.app npm run dev
```

**Important:** Add `https://your-domain.ngrok-free.app/google/callback` as an authorized redirect URI in your Google Cloud Console credentials.

### 5. Connect to claude.ai

1. Go to claude.ai → Settings → MCP Servers → Add
2. Enter your MCP endpoint: `https://your-domain.ngrok-free.app/mcp`
3. Claude.ai will discover the OAuth configuration, redirect you to Google sign-in, and connect automatically

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3847` | Server port |
| `BASE_URL` | `http://localhost:3847` | Public URL of the server (must match what clients use) |

## MCP Tools

### Account

| Tool | Description |
|------|-------------|
| `gmail_whoami` | Check which Gmail account is authenticated |

### Email Operations

| Tool | Description |
|------|-------------|
| `send_email` | Send a new email (to, subject, body, cc, bcc) |
| `get_recent_emails` | Fetch inbox with optional search query and unread filter |
| `get_email` | Get full email details by message ID |
| `get_thread` | Get all messages in a thread |
| `reply_to_email` | Reply to an email, preserving the thread |
| `search_emails` | Search using Gmail query syntax (`from:`, `has:attachment`, etc.) |
| `mark_as_read` | Mark a message as read |
| `mark_as_unread` | Mark a message as unread |
| `trash_email` | Move a message to trash |
| `get_labels` | List all Gmail labels |

### Semantic Search

| Tool | Description |
|------|-------------|
| `gmail_index_emails` | Index recent emails into the vector database |
| `gmail_semantic_search` | Search emails by meaning using natural language |
| `gmail_find_similar` | Find emails semantically similar to a given email |
| `gmail_index_stats` | Get vector index statistics |

### How Semantic Search Works

The server uses the [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) model to generate 384-dimensional embeddings locally — no external API calls needed. Embeddings are stored in SQLite and searched via cosine similarity.

To use it:
1. Call `gmail_index_emails` to index your recent emails (runs once, skips already-indexed)
2. Call `gmail_semantic_search` with natural language queries
3. Call `gmail_find_similar` with a message ID to discover related conversations

## Architecture

```
claude.ai / MCP Client
    │
    ├── MCP OAuth ──→ /.well-known/oauth-authorization-server
    │                  /authorize  →  Google OAuth  →  /google/callback
    │                  /token (exchange code for bearer token)
    │                  /register (dynamic client registration)
    │
    └── MCP Protocol ──→ /mcp (Bearer auth required)
                          │
                          ├── Gmail API (per-user OAuth tokens)
                          └── Vector DB (SQLite + local embeddings)
```

### Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Express HTTP server, MCP tool definitions, OAuth middleware |
| `src/auth.ts` | Google OAuth proxy — bridges MCP OAuth to Google OAuth |
| `src/gmail-operations.ts` | Gmail API operations (send, read, reply, search, labels) |
| `src/vector-db.ts` | SQLite vector store with local transformer embeddings |

### Auth Flow

When a user connects via claude.ai:

1. Claude.ai discovers OAuth metadata at `/.well-known/oauth-authorization-server`
2. Claude.ai dynamically registers as a client via `/register`
3. User is redirected to `/authorize` → Google OAuth consent screen
4. Google redirects back to `/google/callback` with an authorization code
5. Server exchanges the Google code for Gmail tokens, stores them, and issues an MCP auth code
6. Claude.ai exchanges the MCP auth code for a bearer token at `/token`
7. All subsequent MCP requests include the bearer token, which maps to the user's Gmail tokens

Each user's Gmail tokens are isolated. The server can handle multiple concurrent users.

## Data Storage

All persistent data is stored in `~/.gmail-mcp/`:

| File | Description |
|------|-------------|
| `credentials.json` | Google OAuth client credentials (you provide this) |
| `{email}_token.json` | Per-user Google OAuth tokens (auto-created on auth) |
| `emails_vector.db` | SQLite database with email embeddings |

## Security

- OAuth 2.0 only — no passwords stored
- Minimal Gmail scopes (send, read, compose, modify)
- PKCE (S256) enforced on all authorization flows
- Per-user token isolation
- Bearer tokens expire after 1 hour with refresh token rotation
- Google tokens auto-refresh transparently

## Development

```bash
# Run tests (embedding + vector DB)
npm test

# Type check
npx tsc --noEmit

# Build
npm run build
```

## License

ISC
