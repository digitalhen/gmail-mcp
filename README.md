# Gmail MCP Server — Knowledge Graph Edition

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that connects AI assistants to Gmail with a built-in knowledge graph. Authenticate with Google, read and send emails, search semantically, and explore relationships between emails through entities, projects, and topics.

Built on PostgreSQL + pgvector for durable storage, Claude Haiku for AI enrichment, and local transformer embeddings for semantic search.

## Features

- **OAuth integration** — Users authenticate with Google when connecting the MCP server. Tokens persist in Postgres across restarts.
- **Multi-user** — Each user gets isolated Gmail access via their own OAuth tokens.
- **Full Gmail operations** — Send, read, reply, search, label, trash.
- **Semantic search** — pgvector-backed embeddings (all-MiniLM-L6-v2, 384-dim) with HNSW indexing.
- **AI enrichment** — Claude Haiku extracts intent, entities, projects, topics, sentiment from emails.
- **Knowledge graph** — Entities, projects, and tags stored relationally. Multi-hop traversal across entity connections.
- **Project clustering** — AI-driven project consolidation, orphan assignment, and lifecycle management.
- **Self-improvement** — Manual corrections, reclustering, enrichment review.
- **Dockerized** — `docker-compose up` brings up Postgres + app with zero manual steps.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Docker Compose                                  │
│                                                  │
│  ┌──────────────┐    ┌────────────────────────┐ │
│  │  MCP Server   │───▶│  PostgreSQL 16         │ │
│  │  (Express 5)  │    │  + pgvector extension  │ │
│  │  Port 3847    │    │                        │ │
│  └──────────────┘    │  Tables:               │ │
│                       │  - oauth_clients       │ │
│                       │  - oauth_tokens        │ │
│                       │  - emails              │ │
│                       │  - email_enrichment    │ │
│                       │  - entities            │ │
│                       │  - email_entities      │ │
│                       │  - projects            │ │
│                       │  - email_projects      │ │
│                       │  - email_tags          │ │
│                       │  - corrections         │ │
│                       └────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## Setup

### 1. Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project, enable the **Gmail API**
3. Configure OAuth consent screen (External, add test users)
4. Create OAuth credentials: **Web application** type
5. Add authorized redirect URI: `http://localhost:3847/google/callback` (and your public URL if deploying)

### 2. Environment Variables

Create `.env`:

```env
DATABASE_URL=postgresql://gmail_mcp:gmail_mcp@localhost:5433/gmail_mcp
PORT=3847
BASE_URL=http://localhost:3847
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
ANTHROPIC_API_KEY=your-anthropic-key
```

### 3. Run with Docker Compose

```bash
docker-compose up --build
```

This starts Postgres (with pgvector) and the MCP server. Migrations run automatically.

### 4. Run in Development

```bash
docker-compose up db -d    # Start just Postgres
npm install
npm run dev                # Start server with tsx
```

### 5. Connect to claude.ai

For remote access, expose via ngrok:

```bash
ngrok http 3847
BASE_URL=https://your-ngrok-url npm run dev
```

Add `https://your-ngrok-url/google/callback` as an authorized redirect URI in Google Cloud Console, then add `https://your-ngrok-url/mcp` as an MCP server in claude.ai.

## MCP Tools (31 total)

### Account
| Tool | Description |
|------|-------------|
| `gmail_whoami` | Check authenticated Gmail account |

### Email Operations
| Tool | Description |
|------|-------------|
| `send_email` | Send email (to, subject, body, cc, bcc) |
| `get_recent_emails` | Fetch inbox with search query and unread filter |
| `get_email` | Get full email by message ID |
| `get_thread` | Get all messages in a thread |
| `reply_to_email` | Reply preserving thread context |
| `search_emails` | Gmail query syntax search |
| `mark_as_read` / `mark_as_unread` | Toggle read status |
| `trash_email` | Move to trash |
| `get_labels` | List Gmail labels |

### Indexing & Semantic Search
| Tool | Description |
|------|-------------|
| `gmail_index_emails` | Index emails with pagination, auto-enrich, promo filter |
| `gmail_semantic_search` | Natural language search via pgvector |
| `gmail_find_similar` | Find semantically similar emails |
| `gmail_index_stats` | Index statistics |

### AI Enrichment
| Tool | Description |
|------|-------------|
| `gmail_enrich_emails` | Extract intent, entities, projects, topics via Haiku |
| `gmail_enrich_stats` | Enrichment coverage and breakdown |
| `gmail_reembed_enriched` | Re-embed with enriched metadata for better search |

### Knowledge Graph
| Tool | Description |
|------|-------------|
| `gmail_find_related` | 3-way search: project + entity + vector overlap |
| `gmail_multi_hop` | Traverse entity connections across 1-3 hops |

### Project Management
| Tool | Description |
|------|-------------|
| `gmail_list_projects` | All projects with stats |
| `gmail_project_emails` | Emails in a project |
| `gmail_project_summary` | AI-generated project narrative |
| `gmail_consolidate_projects` | AI-driven merge of duplicate projects |
| `gmail_assign_orphans` | Assign unprojecte emails via entity overlap |

### Corrections & Self-Improvement
| Tool | Description |
|------|-------------|
| `gmail_assign_project` | Manually assign email to project |
| `gmail_merge_projects` | Merge two projects |
| `gmail_rename_project` | Rename a project |
| `gmail_recluster` | Full cycle: consolidate + orphans + stale cleanup |
| `gmail_enrichment_review` | Coverage stats and correction patterns |

## Database Schema

10 tables in PostgreSQL with pgvector:

- **oauth_clients** / **oauth_tokens** — MCP OAuth state (survives restarts)
- **emails** — Indexed email metadata + 384-dim vector embeddings
- **email_enrichment** — AI-extracted intent, project, sentiment, type
- **entities** / **email_entities** — Named entity graph
- **projects** / **email_projects** — Life project clustering
- **email_tags** — Topic tags
- **enrichment_corrections** — Manual correction log

## Deployment

### Railway

```bash
# railway.toml is included
# 1. Create Railway project
# 2. Add Postgres plugin
# 3. Set environment variables: DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ANTHROPIC_API_KEY, BASE_URL
# 4. Deploy from GitHub
```

### Docker

```bash
docker-compose up --build
```

## Security

- OAuth 2.0 with PKCE (S256) for MCP authentication
- Google OAuth tokens encrypted in Postgres (not filesystem)
- Per-user data isolation
- Bearer tokens with 1-hour expiry and refresh rotation
- Parameterized SQL queries throughout (no interpolation)

## License

ISC
