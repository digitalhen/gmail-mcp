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
import { enrichEmail, getEnrichmentStats } from "./enrichment.js";
import {
  consolidateProjects,
  assignOrphans,
  listProjects,
  projectEmails,
  projectSummary,
} from "./projects.js";

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
    "Index emails from the last 12 months into the vector database for semantic search. Run this to build up the searchable index. Fetches in batches and skips already-indexed emails.",
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
    },
    async ({ max_results, query }, extra) => {
      try {
        const { gmail, email } = await getGmailFromExtra(extra);
        // Default to last 12 months
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        const dateFilter = `after:${twelveMonthsAgo.getFullYear()}/${String(twelveMonthsAgo.getMonth() + 1).padStart(2, "0")}/${String(twelveMonthsAgo.getDate()).padStart(2, "0")}`;
        const fullQuery = query ? `${dateFilter} ${query}` : dateFilter;

        const emails = await getRecentEmails(gmail, max_results, fullQuery);
        const result = await indexEmails(email, emails);
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

          // 200ms delay between Haiku calls
          if (unenriched.rows.indexOf(row) < unenriched.rows.length - 1) {
            await new Promise((r) => setTimeout(r, 200));
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

        // 1. Project search (weight: 0.4)
        const projectEmails = await db.query(
          `SELECT DISTINCT ep2.email_id, p.name as project_name
           FROM email_projects ep1
           JOIN email_projects ep2 ON ep2.project_id = ep1.project_id
           JOIN projects p ON p.id = ep1.project_id
           WHERE ep1.email_id = $1 AND ep2.email_id != $1`,
          [message_id]
        );
        for (const row of projectEmails.rows) {
          addScore(row.email_id, 0.4, `project: ${row.project_name}`);
        }

        // 2. Entity search (weight: 0.35)
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
        for (const row of entityEmails.rows) {
          const entityScore = Math.min(row.shared_count * 0.175, 0.35);
          addScore(
            row.email_id,
            entityScore,
            `entities: ${row.entity_names.slice(0, 3).join(", ")}`
          );
        }

        // 3. Vector search (weight: 0.25)
        try {
          const vectorResults = await findSimilar(message_id, email, 20);
          for (const r of vectorResults) {
            addScore(r.id, r.similarity * 0.25, `vector: ${r.similarity.toFixed(3)}`);
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
            content: [{ type: "text", text: "No related emails found." }],
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
            { type: "text", text: JSON.stringify(results, null, 2) },
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

  return server;
}

// ─── HTTP Server Setup ───

async function main() {
  // 1. Initialize database
  await db.initialize();

  // 2. Create HNSW index if emails exist
  await db.createHnswIndexIfNeeded();

  const app = express();
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

      if (!code || !state) {
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
