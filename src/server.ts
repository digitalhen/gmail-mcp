import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { db } from "./db.js";
import { GmailOAuthProvider } from "./auth.js";
import {
  sendEmail,
  createDraft,
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
import {
  indexEmails,
  semanticSearch,
  findSimilar,
  getIndexStats,
  generateEmbedding,
} from "./vector-store.js";
import { enrichEmail, getEnrichmentStats, canonicalizeEntity, isOwnerEntity } from "./enrichment.js";
import {
  consolidateProjects,
  assignOrphans,
  listProjects,
  projectEmails,
  projectSummary,
} from "./projects.js";
import {
  assignProject,
  mergeProjects,
  renameProject,
  recluster,
  enrichmentReview,
} from "./corrections.js";
import { indexAllEmails } from "./indexing.js";

const PORT = parseInt(process.env.PORT || "3847", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const authProvider = new GmailOAuthProvider(BASE_URL);

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
    "create_draft",
    "Create a draft email without sending it. The draft will appear in Gmail's Drafts folder. Supports threading via reply_to_message_id to create draft replies.",
    {
      to: z.string().describe("Recipient email address(es), comma-separated"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text"),
      cc: z.string().optional().describe("CC recipients, comma-separated"),
      bcc: z.string().optional().describe("BCC recipients, comma-separated"),
      reply_to_message_id: z.string().optional().describe("Message ID to reply to — sets In-Reply-To/References headers and thread ID for a threaded draft reply"),
    },
    async ({ to, subject, body, cc, bcc, reply_to_message_id }, extra) => {
      try {
        const { gmail, email } = await getGmailFromExtra(extra);

        let inReplyTo: string | undefined;
        let threadId: string | undefined;

        if (reply_to_message_id) {
          const original = await getEmail(gmail, reply_to_message_id);
          inReplyTo = original.messageIdHeader || `<${original.id}@mail.gmail.com>`;
          threadId = original.threadId;
          // Auto-prefix Re: if not already present
          if (!subject.startsWith("Re:")) {
            subject = original.subject.startsWith("Re:")
              ? original.subject
              : `Re: ${original.subject}`;
          }
        }

        const result = await createDraft(gmail, to, subject, body, cc, bcc, inReplyTo, threadId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...result, account: email }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error creating draft: ${error.message}` }],
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
    "Index emails from the last 12 months into the vector database for semantic search. Supports pagination through all matching emails, auto-enrichment, promotional filtering, and smart dedup.",
    {
      max_results: z
        .number()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of emails to index per batch (1-500)"),
      query: z
        .string()
        .optional()
        .describe("Optional additional Gmail search query to filter which emails to index"),
      index_all: z
        .boolean()
        .default(false)
        .describe("When true, paginate through ALL matching emails instead of stopping at max_results"),
      enrich: z
        .boolean()
        .default(false)
        .describe("When true, auto-enrich each email with AI metadata after indexing"),
      skip_promotional: z
        .boolean()
        .default(false)
        .describe("When true, skip likely promotional/marketing emails"),
    },
    async ({ max_results, query, index_all, enrich, skip_promotional }, extra) => {
      try {
        const { gmail, email } = await getGmailFromExtra(extra);
        // Default to last 12 months
        // Skip default date filter if user already provided after: in query
        let fullQuery = query || "";
        if (!fullQuery.includes("after:")) {
          const twelveMonthsAgo = new Date();
          twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
          const dateFilter = `after:${twelveMonthsAgo.getFullYear()}/${String(twelveMonthsAgo.getMonth() + 1).padStart(2, "0")}/${String(twelveMonthsAgo.getDate()).padStart(2, "0")}`;
          fullQuery = fullQuery ? `${dateFilter} ${fullQuery}` : dateFilter;
        }

        if (index_all) {
          const result = await indexAllEmails({
            gmail,
            userEmail: email,
            query: fullQuery,
            batchSize: max_results,
            skipPromotional: skip_promotional,
            enrich,
            onProgress: (indexed, skipped, total) => {
              console.log(`[Indexing] Progress: ${indexed} indexed, ${skipped} skipped, ${total} processed`);
            },
          });

          if (result.indexed > 0) {
            await db.createHnswIndexIfNeeded();
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    message: `Indexed ${result.indexed} emails, skipped ${result.skipped}, ${result.promotional_skipped} promotional filtered, ${result.errors} errors`,
                    ...result,
                    account: email,
                    filter: fullQuery,
                    mode: "paginated",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          const emails = await getRecentEmails(gmail, max_results, fullQuery);
          const result = await indexEmails(email, emails);

          if (result.indexed > 0) {
            await db.createHnswIndexIfNeeded();
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    message: `Indexed ${result.indexed} emails, skipped ${result.skipped} already-indexed emails`,
                    ...result,
                    account: email,
                    filter: fullQuery,
                    mode: "batch",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
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
        const results = await semanticSearch(query, email, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                results.map((r: any) => ({
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
        const results = await findSimilar(message_id, email, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                results.map((r: any) => ({
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
        const stats = await getIndexStats(email);
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

  // ─── Enrichment Tools ───

  server.tool(
    "gmail_enrich_emails",
    "Enrich indexed emails with AI-extracted metadata: intent summary, life projects, entities, topics, sentiment. Uses Claude Haiku for extraction.",
    {
      max_results: z
        .number()
        .min(1)
        .max(200)
        .default(50)
        .describe("Maximum number of unenriched emails to process"),
      query: z
        .string()
        .optional()
        .describe("Optional Gmail search query to filter which indexed emails to enrich"),
    },
    async ({ max_results, query }, extra) => {
      try {
        const { gmail, email } = await getGmailFromExtra(extra);

        // Find unenriched emails
        let sql = `
          SELECT e.id, e.subject, e.from_addr, e.to_addr, e.date, e.body_preview
          FROM emails e
          LEFT JOIN email_enrichment ee ON ee.email_id = e.id
          WHERE e.user_email = $1 AND ee.email_id IS NULL`;
        const params: any[] = [email];

        if (query) {
          sql += ` AND (e.subject ILIKE $2 OR e.snippet ILIKE $2)`;
          params.push(`%${query}%`);
        }

        sql += ` ORDER BY e.indexed_at DESC LIMIT $${params.length + 1}`;
        params.push(max_results);

        const unenriched = await db.query(sql, params);

        let enriched = 0;
        let errors = 0;

        for (const row of unenriched.rows) {
          // If body_preview is short, try to get full body from Gmail
          let body = row.body_preview || "";
          if (body.length < 200) {
            try {
              const fullEmail = await getEmail(gmail, row.id);
              body = fullEmail.body || body;
            } catch {
              // Use what we have
            }
          }

          const result = await enrichEmail(
            row.id,
            row.subject || "",
            row.from_addr || "",
            row.to_addr || "",
            row.date || "",
            body
          );

          if (result) {
            enriched++;
          } else {
            errors++;
          }

          // 50ms delay between Haiku calls
          if (unenriched.rows.indexOf(row) < unenriched.rows.length - 1) {
            await new Promise((r) => setTimeout(r, 50));
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  message: `Enriched ${enriched} emails, ${errors} errors, ${unenriched.rows.length - enriched - errors} skipped`,
                  enriched,
                  errors,
                  total_candidates: unenriched.rows.length,
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
          content: [{ type: "text", text: `Error enriching: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ─── External Enrichment Tools (for Claude Code classification) ───

  server.tool(
    "gmail_get_unenriched",
    "Get indexed emails that have not yet been enriched/classified. Returns email ID, subject, from, to, date, and body text for external classification.",
    {
      max_results: z
        .number()
        .min(1)
        .max(500)
        .default(10)
        .describe("Maximum number of unenriched emails to return"),
      query: z
        .string()
        .optional()
        .describe("Optional search filter on subject/snippet"),
      after_year: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .optional()
        .describe("Only return emails from this year or later (e.g. 2017)"),
    },
    async ({ max_results, query, after_year }, extra) => {
      try {
        const email = getEmailFromExtra(extra);

        let sql = `
          SELECT e.id, e.subject, e.from_addr, e.to_addr, e.date, e.snippet,
                 COALESCE(e.body_full, e.body_preview) as body
          FROM emails e
          LEFT JOIN email_enrichment ee ON ee.email_id = e.id
          WHERE e.user_email = $1 AND ee.email_id IS NULL`;
        const params: any[] = [email];

        if (query) {
          sql += ` AND (e.subject ILIKE $${params.length + 1} OR e.snippet ILIKE $${params.length + 1})`;
          params.push(`%${query}%`);
        }

        if (after_year) {
          sql += ` AND (regexp_match(e.date, '\\b(20[0-9]{2}|19[0-9]{2})\\b'))[1]::int >= $${params.length + 1}`;
          params.push(after_year);
        }

        sql += ` ORDER BY e.date DESC LIMIT $${params.length + 1}`;
        params.push(max_results);

        const result = await db.query(sql, params);

        // Count total unenriched
        const countResult = await db.query(
          `SELECT COUNT(*) as count FROM emails e
           LEFT JOIN email_enrichment ee ON ee.email_id = e.id
           WHERE e.user_email = $1 AND ee.email_id IS NULL`,
          [email]
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  total_unenriched: parseInt(countResult.rows[0].count),
                  returned: result.rows.length,
                  emails: result.rows.map((r: any) => ({
                    id: r.id,
                    subject: r.subject,
                    from: r.from_addr,
                    to: r.to_addr,
                    date: r.date,
                    body: r.body?.slice(0, 3000) || r.snippet || "",
                  })),
                },
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
    "gmail_write_enrichment",
    "Write enrichment/classification data for an email. Accepts the same JSON structure as the AI enrichment pipeline: intent_summary, life_project, entities, topics, key_dates, sentiment, email_type.",
    {
      email_id: z.string().describe("Gmail message ID to enrich"),
      enrichment: z.object({
        intent_summary: z.string().describe("One sentence: what is this email about?"),
        life_project: z.string().nullable().describe("Broader project/initiative name, or null"),
        entities: z.array(z.object({
          name: z.string(),
          type: z.enum(["person", "place", "organization", "flight", "document", "event", "institution"]),
          role: z.enum(["sender", "recipient", "mentioned", "location", "destination", "provider", "subject"]),
        })).default([]),
        topics: z.array(z.string()).default([]).describe("Tags from: travel, coparenting, medical, legal, career, finance, technology, family, school, home, civic, insurance, food, shopping, media, passport, immigration"),
        key_dates: z.array(z.object({
          date: z.string().describe("YYYY-MM-DD"),
          description: z.string(),
        })).default([]),
        sentiment: z.enum(["positive", "negative", "neutral", "urgent", "confrontational"]),
        email_type: z.enum(["personal", "professional", "transactional", "promotional", "notification", "legal"]),
      }),
    },
    async ({ email_id, enrichment }, extra) => {
      try {
        const email = getEmailFromExtra(extra);

        // Verify this email belongs to the authenticated user
        const emailCheck = await db.query(
          "SELECT id FROM emails WHERE id = $1 AND user_email = $2",
          [email_id, email]
        );
        if (emailCheck.rows.length === 0) {
          return {
            content: [{ type: "text", text: `Error: Email ${email_id} not found or not owned by ${email}` }],
            isError: true,
          };
        }

        // Filter out owner entities
        const filteredEntities = (enrichment.entities || []).filter(
          (e) => !isOwnerEntity(e.name)
        );

        await db.transaction(async (client) => {
          // 1. Insert email_enrichment
          await client.query(
            `INSERT INTO email_enrichment (email_id, intent_summary, life_project, sentiment, email_type, is_transactional, is_promotional, enrichment_model, enrichment_raw)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (email_id) DO UPDATE SET
               intent_summary = EXCLUDED.intent_summary,
               life_project = EXCLUDED.life_project,
               sentiment = EXCLUDED.sentiment,
               email_type = EXCLUDED.email_type,
               is_transactional = EXCLUDED.is_transactional,
               is_promotional = EXCLUDED.is_promotional,
               enrichment_model = EXCLUDED.enrichment_model,
               enrichment_raw = EXCLUDED.enrichment_raw,
               enriched_at = NOW()`,
            [
              email_id,
              enrichment.intent_summary,
              enrichment.life_project,
              enrichment.sentiment,
              enrichment.email_type,
              enrichment.email_type === "transactional",
              enrichment.email_type === "promotional",
              "claude-code-manual",
              JSON.stringify(enrichment),
            ]
          );

          // 2. If promotional, flag in emails table
          if (enrichment.email_type === "promotional") {
            await client.query(
              "UPDATE emails SET is_promotional = true WHERE id = $1",
              [email_id]
            );
          }

          // 3. Insert entities
          for (const entity of filteredEntities) {
            const canonicalName = canonicalizeEntity(entity.name, entity.type);

            const entityResult = await client.query(
              `INSERT INTO entities (name, entity_type, canonical_name)
               VALUES ($1, $2, $3)
               ON CONFLICT (canonical_name, entity_type) DO UPDATE SET name = EXCLUDED.name
               RETURNING id`,
              [entity.name, entity.type, canonicalName]
            );

            await client.query(
              `INSERT INTO email_entities (email_id, entity_id, role)
               VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING`,
              [email_id, entityResult.rows[0].id, entity.role]
            );
          }

          // 4. Insert tags
          for (const tag of enrichment.topics || []) {
            await client.query(
              `INSERT INTO email_tags (email_id, tag)
               VALUES ($1, $2)
               ON CONFLICT DO NOTHING`,
              [email_id, tag]
            );
          }

          // 5. Insert key_dates
          for (const kd of enrichment.key_dates || []) {
            if (kd.date) {
              await client.query(
                `INSERT INTO email_dates (email_id, date, description)
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [email_id, kd.date, kd.description]
              );
            }
          }

          // 6. Insert/update project
          if (enrichment.life_project) {
            const projectResult = await client.query(
              `INSERT INTO projects (name, first_seen, last_activity)
               VALUES ($1, NOW(), NOW())
               ON CONFLICT (name) DO UPDATE SET last_activity = NOW()
               RETURNING id`,
              [enrichment.life_project]
            );

            await client.query(
              `INSERT INTO email_projects (email_id, project_id, assigned_by)
               VALUES ($1, $2, 'llm')
               ON CONFLICT DO NOTHING`,
              [email_id, projectResult.rows[0].id]
            );
          }
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                email_id,
                intent: enrichment.intent_summary,
                project: enrichment.life_project,
                type: enrichment.email_type,
                entities: filteredEntities.length,
                tags: enrichment.topics?.length || 0,
              }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error writing enrichment: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "gmail_enrich_stats",
    "Get enrichment statistics: total/enriched emails, projects, entities, tags, sentiment breakdown.",
    {},
    async (_, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const stats = await getEnrichmentStats(email);
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

  // ─── Sprint 2: Entity-Aware Search Tools ───

  server.tool(
    "gmail_reembed_enriched",
    "Re-embed enriched emails with richer text that includes intent, project, topics, and entities. Improves semantic search quality.",
    {
      max_results: z.number().min(1).max(500).default(100).describe("Max emails to re-embed"),
    },
    async ({ max_results }, extra) => {
      try {
        const email = getEmailFromExtra(extra);

        const rows = await db.query(
          `SELECT e.id, e.subject, e.from_addr, e.body_preview,
                  ee.intent_summary, ee.life_project
           FROM emails e
           JOIN email_enrichment ee ON ee.email_id = e.id
           WHERE e.user_email = $1 AND ee.embedding_enriched = false
           LIMIT $2`,
          [email, max_results]
        );

        let reembedded = 0;
        for (const row of rows.rows) {
          // Get tags and entities for this email
          const tags = await db.query(
            "SELECT tag FROM email_tags WHERE email_id = $1",
            [row.id]
          );
          const entities = await db.query(
            `SELECT en.name FROM entities en
             JOIN email_entities ee ON ee.entity_id = en.id
             WHERE ee.email_id = $1`,
            [row.id]
          );

          const enrichedText = [
            `Subject: ${row.subject || ""}`,
            `From: ${row.from_addr || ""}`,
            `Intent: ${row.intent_summary || ""}`,
            `Project: ${row.life_project || "none"}`,
            `Topics: ${tags.rows.map((t: any) => t.tag).join(", ") || "none"}`,
            `Entities: ${entities.rows.map((e: any) => e.name).join(", ") || "none"}`,
            `Body: ${(row.body_preview || "").slice(0, 1000)}`,
          ].join("\n");

          const embedding = await generateEmbedding(enrichedText);
          const vectorStr = `[${embedding.join(",")}]`;

          await db.query(
            "UPDATE emails SET embedding = $1::vector WHERE id = $2",
            [vectorStr, row.id]
          );
          await db.query(
            "UPDATE email_enrichment SET embedding_enriched = true WHERE email_id = $1",
            [row.id]
          );
          reembedded++;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ reembedded, account: email }, null, 2),
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
    "gmail_find_related",
    "Find related emails using a 3-way search: project overlap, shared entities, and vector similarity. Returns results with match reasons.",
    {
      message_id: z.string().describe("The message ID to find related emails for"),
      limit: z.number().min(1).max(50).default(15).describe("Maximum results"),
    },
    async ({ message_id, limit }, extra) => {
      try {
        const email = getEmailFromExtra(extra);

        // Score maps: emailId → { score, reasons }
        const scores: Record<string, { score: number; reasons: string[] }> = {};

        function addScore(id: string, score: number, reason: string) {
          if (id === message_id) return;
          if (!scores[id]) scores[id] = { score: 0, reasons: [] };
          scores[id].score += score;
          scores[id].reasons.push(reason);
        }

        // Diagnostics for debugging
        const diagnostics: any = {
          project_matches: 0,
          entity_matches: 0,
          vector_matches: 0,
          seed_has_enrichment: false,
          seed_projects: [] as string[],
          seed_entity_count: 0,
        };

        // Check seed email enrichment status
        const seedEnrichment = await db.query(
          "SELECT 1 FROM email_enrichment WHERE email_id = $1",
          [message_id]
        );
        diagnostics.seed_has_enrichment = seedEnrichment.rows.length > 0;

        const seedProjects = await db.query(
          `SELECT p.name FROM email_projects ep JOIN projects p ON p.id = ep.project_id WHERE ep.email_id = $1`,
          [message_id]
        );
        diagnostics.seed_projects = seedProjects.rows.map((r: any) => r.name);

        const seedEntities = await db.query(
          "SELECT COUNT(*) as count FROM email_entities WHERE email_id = $1",
          [message_id]
        );
        diagnostics.seed_entity_count = parseInt(seedEntities.rows[0].count);

        // 1. Project search (weight: 1.0 — binary, strongest signal)
        const projectEmails = await db.query(
          `SELECT DISTINCT ep2.email_id, p.name as project_name
           FROM email_projects ep1
           JOIN email_projects ep2 ON ep2.project_id = ep1.project_id
           JOIN projects p ON p.id = ep1.project_id
           WHERE ep1.email_id = $1 AND ep2.email_id != $1`,
          [message_id]
        );
        diagnostics.project_matches = projectEmails.rows.length;
        for (const row of projectEmails.rows) {
          addScore(row.email_id, 1.0, `project: ${row.project_name}`);
        }

        // 2. Entity search (weight: 0.5, scaled by shared count)
        const entityEmails = await db.query(
          `SELECT ee2.email_id, COUNT(DISTINCT ee2.entity_id) as shared_count,
                  array_agg(DISTINCT en.name) as entity_names
           FROM email_entities ee1
           JOIN email_entities ee2 ON ee2.entity_id = ee1.entity_id
           JOIN entities en ON en.id = ee1.entity_id
           WHERE ee1.email_id = $1 AND ee2.email_id != $1
           GROUP BY ee2.email_id
           HAVING COUNT(DISTINCT ee2.entity_id) >= 2
           ORDER BY shared_count DESC`,
          [message_id]
        );
        diagnostics.entity_matches = entityEmails.rows.length;
        // Normalize entity scores against max
        const maxShared = entityEmails.rows.length > 0
          ? Math.max(...entityEmails.rows.map((r: any) => parseInt(r.shared_count)))
          : 1;
        for (const row of entityEmails.rows) {
          const normalized = parseInt(row.shared_count) / maxShared;
          addScore(
            row.email_id,
            normalized * 0.5,
            `entities(${row.shared_count}): ${row.entity_names.slice(0, 3).join(", ")}`
          );
        }

        // 3. Vector search (weight: 0.3)
        try {
          const vectorResults = await findSimilar(message_id, email, 20);
          diagnostics.vector_matches = vectorResults.length;
          for (const r of vectorResults) {
            addScore(r.id, r.similarity * 0.3, `vector: ${r.similarity.toFixed(3)}`);
          }
        } catch {
          // Vector search may fail if email not indexed — that's OK
        }

        // Sort by combined score, fetch metadata
        const sorted = Object.entries(scores)
          .sort(([, a], [, b]) => b.score - a.score)
          .slice(0, limit);

        if (sorted.length === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ diagnostics, results: [] }, null, 2) }],
          };
        }

        const ids = sorted.map(([id]) => id);
        const metadata = await db.query(
          `SELECT id, subject, from_addr, to_addr, date, snippet
           FROM emails WHERE id = ANY($1)`,
          [ids]
        );

        const metaMap = new Map(metadata.rows.map((r: any) => [r.id, r]));

        const results = sorted.map(([id, { score, reasons }]) => {
          const meta = metaMap.get(id) || {};
          return {
            id,
            subject: meta.subject,
            from: meta.from_addr,
            to: meta.to_addr,
            date: meta.date,
            snippet: meta.snippet,
            score: Math.round(score * 1000) / 1000,
            match_reasons: reasons,
          };
        });

        return {
          content: [
            { type: "text", text: JSON.stringify({ diagnostics, results }, null, 2) },
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
    "gmail_multi_hop",
    "Hop through entity connections to discover indirect relationships between emails. Each hop finds emails sharing 2+ entities with the previous hop's results.",
    {
      message_id: z.string().describe("The starting message ID"),
      hops: z.number().min(1).max(3).default(2).describe("Number of hops (1-3)"),
      limit: z.number().min(1).max(50).default(20).describe("Maximum results per hop"),
    },
    async ({ message_id, hops, limit }, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const allResults: Array<{
          hop: number;
          emails: any[];
          entities_discovered: string[];
        }> = [];

        let currentIds = [message_id];
        const seenIds = new Set([message_id]);

        // Check if seed has entities; if not, try to enrich it on-the-fly
        const seedEntityCheck = await db.query(
          "SELECT COUNT(*) as count FROM email_entities WHERE email_id = $1",
          [message_id]
        );
        if (parseInt(seedEntityCheck.rows[0].count) === 0) {
          // Try to enrich the seed email
          const seedEmail = await db.query(
            "SELECT subject, from_addr, to_addr, date, body_preview, body_full FROM emails WHERE id = $1",
            [message_id]
          );
          if (seedEmail.rows.length > 0) {
            const s = seedEmail.rows[0];
            await enrichEmail(
              message_id,
              s.subject || "",
              s.from_addr || "",
              s.to_addr || "",
              s.date || "",
              s.body_full || s.body_preview || ""
            );
          }
        }

        for (let hop = 1; hop <= hops; hop++) {
          if (currentIds.length === 0) break;

          // Find emails sharing 2+ entities with current set
          const hopResults = await db.query(
            `SELECT ee2.email_id, COUNT(DISTINCT ee2.entity_id) as shared_count,
                    array_agg(DISTINCT en.name) as shared_entities
             FROM email_entities ee1
             JOIN email_entities ee2 ON ee2.entity_id = ee1.entity_id
             JOIN entities en ON en.id = ee2.entity_id
             JOIN emails e ON e.id = ee2.email_id
             WHERE ee1.email_id = ANY($1)
               AND ee2.email_id != ALL($1)
               AND e.user_email = $2
               AND ee2.email_id != ALL($3)
             GROUP BY ee2.email_id
             HAVING COUNT(DISTINCT ee2.entity_id) >= 2
             ORDER BY shared_count DESC
             LIMIT $4`,
            [currentIds, email, Array.from(seenIds), limit]
          );

          const hopIds = hopResults.rows.map((r: any) => r.email_id);
          if (hopIds.length === 0) break;

          // Fetch metadata
          const metadata = await db.query(
            `SELECT id, subject, from_addr, date, snippet FROM emails WHERE id = ANY($1)`,
            [hopIds]
          );
          const metaMap = new Map(metadata.rows.map((r: any) => [r.id, r]));

          // Collect new entities discovered in this hop
          const newEntities = new Set<string>();
          for (const row of hopResults.rows) {
            for (const name of row.shared_entities || []) {
              newEntities.add(name);
            }
          }

          allResults.push({
            hop,
            emails: hopResults.rows.map((r: any) => {
              const meta = metaMap.get(r.email_id) || {};
              return {
                id: r.email_id,
                subject: meta.subject,
                from: meta.from_addr,
                date: meta.date,
                snippet: meta.snippet,
                shared_entities: r.shared_entities,
                shared_count: parseInt(r.shared_count),
              };
            }),
            entities_discovered: Array.from(newEntities),
          });

          // Prepare for next hop
          for (const id of hopIds) seenIds.add(id);
          currentIds = hopIds;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { starting_email: message_id, hops: allResults },
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

  // ─── Sprint 3: Project Clustering Tools ───

  server.tool(
    "gmail_consolidate_projects",
    "Use AI to merge duplicate/variant project names (e.g., 'UK Trip' and 'London Trip March 2026'). Sends project list to Haiku for merge suggestions, then applies them.",
    {},
    async (_, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const result = await consolidateProjects(email);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { message: `Merged ${result.merged} project variants`, ...result },
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
    "gmail_assign_orphans",
    "Find enriched emails with no project assignment and try to assign them via entity overlap with existing projects.",
    {
      max_results: z.number().min(1).max(200).default(50).describe("Max orphan emails to process"),
    },
    async ({ max_results }, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const result = await assignOrphans(email, max_results);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { message: `Assigned ${result.assigned} orphan emails, ${result.unassigned} remain unassigned`, ...result },
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
    "gmail_list_projects",
    "List all projects with email counts, date ranges, and status.",
    {},
    async (_, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const projects = await listProjects(email);
        return {
          content: [
            { type: "text", text: JSON.stringify(projects, null, 2) },
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
    "gmail_project_emails",
    "Get all emails belonging to a specific project.",
    {
      project_name: z.string().describe("The project name"),
      limit: z.number().min(1).max(100).default(30).describe("Maximum emails to return"),
    },
    async ({ project_name, limit }, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const emails = await projectEmails(email, project_name, limit);
        return {
          content: [
            { type: "text", text: JSON.stringify(emails, null, 2) },
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
    "gmail_project_summary",
    "Generate an AI narrative summary of a project: what it's about, who's involved, key dates, and current status.",
    {
      project_name: z.string().describe("The project name to summarize"),
    },
    async ({ project_name }, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const summary = await projectSummary(email, project_name);
        return {
          content: [{ type: "text", text: summary }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ─── Sprint 4: Correction + Self-Improvement Tools ───

  server.tool(
    "gmail_assign_project",
    "Manually assign an email to a project. Creates the project if it doesn't exist. Logs the correction.",
    {
      message_id: z.string().describe("The email message ID"),
      project_name: z.string().describe("The project name to assign to"),
    },
    async ({ message_id, project_name }, extra) => {
      try {
        getEmailFromExtra(extra); // auth check
        const result = await assignProject(message_id, project_name);
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
    "gmail_merge_projects",
    "Merge one project into another. Moves all email associations and deletes the source project.",
    {
      from_project: z.string().describe("Project name to merge FROM (will be deleted)"),
      to_project: z.string().describe("Project name to merge INTO (will be kept)"),
    },
    async ({ from_project, to_project }, extra) => {
      try {
        getEmailFromExtra(extra);
        const result = await mergeProjects(from_project, to_project);
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
    "gmail_rename_project",
    "Rename a project.",
    {
      old_name: z.string().describe("Current project name"),
      new_name: z.string().describe("New project name"),
    },
    async ({ old_name, new_name }, extra) => {
      try {
        getEmailFromExtra(extra);
        const result = await renameProject(old_name, new_name);
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
    "gmail_recluster",
    "Full improvement cycle: consolidate duplicate projects, assign orphan emails, mark stale projects as completed.",
    {},
    async (_, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const result = await recluster(email);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ account: email, ...result }, null, 2),
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
    "gmail_enrichment_review",
    "Review enrichment quality: coverage stats, correction patterns, and recent corrections.",
    {},
    async (_, extra) => {
      try {
        const email = getEmailFromExtra(extra);
        const report = await enrichmentReview(email);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ account: email, ...report }, null, 2),
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

  // ─── Cleanup Tools ───

  server.tool(
    "gmail_cleanup_promotionals",
    "Clean up already-enriched promotional emails: remove from projects, remove their entities from the graph, flag them in the emails table.",
    {},
    async (_, extra) => {
      try {
        const email = getEmailFromExtra(extra);

        // Find promotional emails for this user
        const promos = await db.query(
          `SELECT e.id FROM emails e
           JOIN email_enrichment ee ON ee.email_id = e.id
           WHERE e.user_email = $1 AND (ee.is_promotional = true OR ee.email_type = 'promotional')`,
          [email]
        );

        let cleaned = 0;
        for (const row of promos.rows) {
          await db.query("DELETE FROM email_projects WHERE email_id = $1", [row.id]);
          await db.query("DELETE FROM email_entities WHERE email_id = $1", [row.id]);
          await db.query("UPDATE emails SET is_promotional = true WHERE id = $1", [row.id]);
          cleaned++;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ cleaned, account: email }, null, 2),
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
    "gmail_consolidate_entities",
    "Use AI to merge duplicate entity names (e.g., 'Amazon.com' and 'Amazon'). Sends top entities to Haiku for merge suggestions.",
    {},
    async (_, extra) => {
      try {
        const email = getEmailFromExtra(extra);

        const entities = await db.query(
          `SELECT en.id, en.name, en.entity_type, en.canonical_name, COUNT(ee.email_id) as email_count
           FROM entities en
           JOIN email_entities ee ON ee.entity_id = en.id
           JOIN emails e ON e.id = ee.email_id
           WHERE e.user_email = $1
           GROUP BY en.id
           ORDER BY email_count DESC
           LIMIT 100`,
          [email]
        );

        if (entities.rows.length < 2) {
          return { content: [{ type: "text", text: "Not enough entities to consolidate." }] };
        }

        const entityList = entities.rows
          .map((e: any) => `- "${e.name}" (${e.entity_type}, ${e.email_count} emails)`)
          .join("\n");

        const anthropic = new (await import("@anthropic-ai/sdk")).default();
        const message = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: `Merge duplicate entities in a personal email knowledge graph. Only merge if they clearly refer to the same entity.

Entities:
${entityList}

Respond ONLY in JSON, no backticks:
{"merges": [{"from_ids": [1, 2], "to_name": "canonical name", "to_type": "type"}]}

If no merges needed, return {"merges": []}`,
            },
          ],
        });

        const responseText = message.content[0].type === "text" ? message.content[0].text : "{}";
        let cleaned = responseText.trim();
        if (cleaned.startsWith("```")) {
          cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
        }
        const result = JSON.parse(cleaned);

        let merged = 0;
        for (const merge of result.merges || []) {
          if (!merge.from_ids || merge.from_ids.length < 2) continue;

          const keepId = merge.from_ids[0];
          const mergeIds = merge.from_ids.slice(1);

          // Update canonical name on kept entity
          await db.query(
            "UPDATE entities SET name = $1, canonical_name = $2 WHERE id = $3",
            [merge.to_name, merge.to_name.toLowerCase().trim(), keepId]
          );

          // Move email_entities links
          for (const fromId of mergeIds) {
            await db.query(
              `UPDATE email_entities SET entity_id = $1
               WHERE entity_id = $2
               AND (email_id, $1, role) NOT IN (SELECT email_id, entity_id, role FROM email_entities WHERE entity_id = $1)`,
              [keepId, fromId]
            );
            await db.query("DELETE FROM email_entities WHERE entity_id = $1", [fromId]);
            await db.query("DELETE FROM entities WHERE id = $1", [fromId]);
          }
          merged += mergeIds.length;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ merged, merges: result.merges || [], account: email }, null, 2),
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

async function main() {
  // 1. Initialize database
  await db.initialize();

  // 2. Create HNSW index if emails exist
  await db.createHnswIndexIfNeeded();

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`
      );
    });
    next();
  });

  // Install MCP OAuth routes
  const issuerUrl = new URL(BASE_URL);
  app.use(
    mcpAuthRouter({
      provider: authProvider,
      issuerUrl,
      scopesSupported: ["gmail"],
      resourceName: "Gmail MCP Server",
    })
  );

  // Google OAuth callback
  app.get("/google/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string;

      if (req.query.error) {
        console.error("Google OAuth error:", req.query.error, req.query.error_description);
        res.status(400).send(`Google OAuth error: ${req.query.error} - ${req.query.error_description || ""}`);
        return;
      }

      if (!code || !state) {
        console.error("Google callback missing params. Query:", req.query);
        res.status(400).send("Missing code or state parameter");
        return;
      }

      const { redirectUrl } = await authProvider.handleGoogleCallback(
        code,
        state
      );
      res.redirect(redirectUrl);
    } catch (error: any) {
      console.error("Google callback error:", error);
      res.status(500).send(`Authentication failed: ${error.message}`);
    }
  });

  // Bearer auth middleware for MCP endpoints
  const bearerAuth = requireBearerAuth({
    verifier: authProvider,
    resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource", BASE_URL).href,
  });

  // Store transports by session ID
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", bearerAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // If client sent a session ID we don't recognize (e.g. after server restart),
    // return 404 so the client knows to start a fresh session per MCP spec.
    if (sessionId) {
      res.status(404).json({ error: "Session not found. Please reinitialize." });
      return;
    }

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
  app.get("/health", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ok", server: "gmail-mcp", version: "1.0.0", database: "connected" });
    } catch {
      res.status(503).json({ status: "error", server: "gmail-mcp", database: "disconnected" });
    }
  });

  // 3. Start Express server
  app.listen(PORT, () => {
    console.log(`Gmail MCP server running on ${BASE_URL}`);
    console.log(`MCP endpoint: ${BASE_URL}/mcp`);
    console.log(`OAuth metadata: ${BASE_URL}/.well-known/oauth-authorization-server`);
    console.log(`Health check: ${BASE_URL}/health`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
