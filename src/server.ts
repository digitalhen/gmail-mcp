import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { GmailOAuthProvider } from "./auth.js";
import {
  sendEmail,
  getRecentEmails,
  getEmail,
  getThread,
  replyToEmail,
  searchEmails,
  markAsRead,
  markAsUnread,
  trashEmail,
  getLabels,
} from "./gmail-operations.js";
import { VectorDB } from "./vector-db.js";

const PORT = parseInt(process.env.PORT || "3847", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const authProvider = new GmailOAuthProvider(BASE_URL);
const vectorDB = new VectorDB(authProvider.getDataDir());

// Helper to get Gmail service from the auth info in tool extra
async function getGmailFromExtra(extra: any) {
  const authInfo = extra?.authInfo;
  if (!authInfo?.token) {
    throw new Error("Not authenticated. Please connect your Gmail account.");
  }
  return authProvider.getGmailServiceForToken(authInfo.token);
}

function getEmailFromExtra(extra: any): string {
  const email = extra?.authInfo?.extra?.email;
  if (!email) {
    throw new Error("Not authenticated. Please connect your Gmail account.");
  }
  return email as string;
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "gmail-mcp",
    version: "1.0.0",
  });

  // ─── Account Info Tool ───

  server.tool(
    "gmail_whoami",
    "Check which Gmail account is currently authenticated.",
    {},
    async (_, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        return {
          content: [{ type: "text", text: `Authenticated as ${email}` }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    }
  );

  // ─── Email Operation Tools ───

  server.tool(
    "send_email",
    "Send a new email from the authenticated Gmail account.",
    {
      to: z.string().describe("Recipient email address(es), comma-separated"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text"),
      cc: z.string().optional().describe("CC recipients, comma-separated"),
      bcc: z.string().optional().describe("BCC recipients, comma-separated"),
    },
    async ({ to, subject, body, cc, bcc }, extra) => {
      try {
        const { gmail, email } = await getGmailFromExtra(extra);
        const result = await sendEmail(gmail, to, subject, body, cc, bcc);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...result, sent_from: email }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error sending email: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_recent_emails",
    "Fetch recent emails from the inbox. Supports filtering by search query and unread status.",
    {
      max_results: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of emails to return (1-50)"),
      query: z
        .string()
        .optional()
        .describe("Gmail search query (e.g., 'from:user@example.com', 'subject:invoice')"),
      unread_only: z
        .boolean()
        .default(false)
        .describe("Only return unread emails"),
    },
    async ({ max_results, query, unread_only }, extra) => {
      try {
        const { gmail } = await getGmailFromExtra(extra);
        const emails = await getRecentEmails(gmail, max_results, query, unread_only);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                emails.map((e) => ({
                  id: e.id,
                  threadId: e.threadId,
                  from: e.from,
                  to: e.to,
                  subject: e.subject,
                  date: e.date,
                  snippet: e.snippet,
                  isUnread: e.isUnread,
                })),
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error fetching emails: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_email",
    "Get full details of a specific email by its message ID.",
    {
      message_id: z.string().describe("The Gmail message ID"),
    },
    async ({ message_id }, extra) => {
      try {
        const { gmail } = await getGmailFromExtra(extra);
        const email = await getEmail(gmail, message_id);
        return {
          content: [{ type: "text", text: JSON.stringify(email, null, 2) }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error fetching email: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_thread",
    "Get all messages in an email thread.",
    {
      thread_id: z.string().describe("The Gmail thread ID"),
    },
    async ({ thread_id }, extra) => {
      try {
        const { gmail } = await getGmailFromExtra(extra);
        const messages = await getThread(gmail, thread_id);
        return {
          content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error fetching thread: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "reply_to_email",
    "Reply to an existing email, preserving the thread.",
    {
      message_id: z.string().describe("The message ID to reply to"),
      body: z.string().describe("Reply body text"),
    },
    async ({ message_id, body }, extra) => {
      try {
        const { gmail, email } = await getGmailFromExtra(extra);
        const result = await replyToEmail(gmail, message_id, body);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...result, sent_from: email }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error replying: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "search_emails",
    "Search emails using Gmail's search syntax.",
    {
      query: z
        .string()
        .describe(
          "Gmail search query (e.g., 'from:user@example.com has:attachment after:2024/01/01')"
        ),
      max_results: z.number().min(1).max(50).default(10).describe("Maximum results"),
    },
    async ({ query, max_results }, extra) => {
      try {
        const { gmail } = await getGmailFromExtra(extra);
        const emails = await searchEmails(gmail, query, max_results);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                emails.map((e) => ({
                  id: e.id,
                  threadId: e.threadId,
                  from: e.from,
                  to: e.to,
                  subject: e.subject,
                  date: e.date,
                  snippet: e.snippet,
                  isUnread: e.isUnread,
                })),
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error searching: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "mark_as_read",
    "Mark an email as read.",
    { message_id: z.string().describe("The message ID") },
    async ({ message_id }, extra) => {
      try {
        const { gmail } = await getGmailFromExtra(extra);
        const result = await markAsRead(gmail, message_id);
        return { content: [{ type: "text", text: result.message }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "mark_as_unread",
    "Mark an email as unread.",
    { message_id: z.string().describe("The message ID") },
    async ({ message_id }, extra) => {
      try {
        const { gmail } = await getGmailFromExtra(extra);
        const result = await markAsUnread(gmail, message_id);
        return { content: [{ type: "text", text: result.message }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "trash_email",
    "Move an email to trash.",
    { message_id: z.string().describe("The message ID") },
    async ({ message_id }, extra) => {
      try {
        const { gmail } = await getGmailFromExtra(extra);
        const result = await trashEmail(gmail, message_id);
        return { content: [{ type: "text", text: result.message }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_labels",
    "Get all Gmail labels for the current account.",
    {},
    async (_, extra) => {
      try {
        const { gmail } = await getGmailFromExtra(extra);
        const labels = await getLabels(gmail);
        return {
          content: [{ type: "text", text: JSON.stringify(labels, null, 2) }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ─── Vector / Semantic Search Tools ───

  server.tool(
    "gmail_index_emails",
    "Index recent emails into the vector database for semantic search. Run this to build up the searchable index.",
    {
      max_results: z
        .number()
        .min(1)
        .max(100)
        .default(50)
        .describe("Number of recent emails to index"),
      query: z
        .string()
        .optional()
        .describe("Optional Gmail search query to filter which emails to index"),
    },
    async ({ max_results, query }, extra) => {
      try {
        const { gmail, email } = await getGmailFromExtra(extra);
        const emails = await getRecentEmails(gmail, max_results, query);
        const result = await vectorDB.indexEmails(email, emails);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  message: `Indexed ${result.indexed} emails, skipped ${result.skipped} already-indexed emails`,
                  ...result,
                  account: email,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error indexing: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "gmail_semantic_search",
    "Search emails using natural language. Finds semantically similar emails based on meaning, not just keywords. For example, searching 'phone calls' will also find emails about FaceTime, Zoom calls, etc.",
    {
      query: z
        .string()
        .describe(
          "Natural language search query (e.g., 'emails about project deadlines', 'discussions about budget concerns')"
        ),
      limit: z.number().min(1).max(50).default(10).describe("Maximum results to return"),
    },
    async ({ query, limit }, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const results = await vectorDB.semanticSearch(email, query, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                results.map((r) => ({
                  ...r,
                  similarity: Math.round(r.similarity * 1000) / 1000,
                })),
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error searching: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "gmail_find_similar",
    "Find emails that are semantically similar to a specific email. Useful for discovering related conversations.",
    {
      message_id: z.string().describe("The message ID to find similar emails for"),
      limit: z.number().min(1).max(50).default(10).describe("Maximum results"),
    },
    async ({ message_id, limit }, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const results = await vectorDB.findSimilarEmails(email, message_id, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                results.map((r) => ({
                  ...r,
                  similarity: Math.round(r.similarity * 1000) / 1000,
                })),
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "gmail_index_stats",
    "Get statistics about the vector index for the current account.",
    {},
    async (_, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const stats = vectorDB.getIndexStats(email);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ account: email, ...stats }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ─── HTTP Server Setup ───

const app = express();
app.use(express.json());

// Install MCP OAuth routes (/.well-known/*, /authorize, /token, /register, /revoke)
const issuerUrl = new URL(BASE_URL);
app.use(
  mcpAuthRouter({
    provider: authProvider,
    issuerUrl,
    scopesSupported: ["gmail"],
    resourceName: "Gmail MCP Server",
  })
);

// Google OAuth callback — this is where Google redirects after user consent
app.get("/google/callback", async (req, res) => {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!code || !state) {
      res.status(400).send("Missing code or state parameter");
      return;
    }

    const { redirectUrl } = await authProvider.handleGoogleCallback(code, state);
    res.redirect(redirectUrl);
  } catch (error: any) {
    console.error("Google callback error:", error);
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
});

// Bearer auth middleware for MCP endpoints
const bearerAuth = requireBearerAuth({
  verifier: authProvider,
  resourceMetadataUrl: "/.well-known/oauth-protected-resource",
});

// Store transports by session ID
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", bearerAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports[sid] = transport;
      console.log(`MCP session created: ${sid}`);
    },
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && transports[sid]) {
      delete transports[sid];
      console.log(`MCP session closed: ${sid}`);
    }
  };

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", bearerAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/mcp", bearerAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// Health check (no auth required)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "gmail-mcp", version: "1.0.0" });
});

app.listen(PORT, () => {
  console.log(`Gmail MCP server running on ${BASE_URL}`);
  console.log(`MCP endpoint: ${BASE_URL}/mcp`);
  console.log(`OAuth metadata: ${BASE_URL}/.well-known/oauth-authorization-server`);
  console.log(`Health check: ${BASE_URL}/health`);
  console.log(`Data directory: ${authProvider.getDataDir()}`);
});
