import { gmail_v1 } from "googleapis";
import { indexEmail, computeBodyHash, generateEmbedding } from "./vector-store.js";
import { enrichEmail } from "./enrichment.js";
import { db } from "./db.js";

// Promotional sender patterns (conservative)
const PROMO_PATTERNS = [
  /noreply@/i,
  /no-reply@/i,
  /newsletter@/i,
  /marketing@/i,
  /promo@/i,
  /deals@/i,
  /offers@/i,
  /notifications@.*\.com$/i,
];

const PROMO_HEADERS = ["List-Unsubscribe", "List-Unsubscribe-Post"];

function isLikelyPromotional(
  from: string,
  headers?: gmail_v1.Schema$MessagePartHeader[]
): boolean {
  // Check sender patterns
  for (const pattern of PROMO_PATTERNS) {
    if (pattern.test(from)) return true;
  }

  // Check for List-Unsubscribe header
  if (headers) {
    for (const h of headers) {
      if (
        PROMO_HEADERS.includes(h.name || "") &&
        h.value
      ) {
        return true;
      }
    }
  }

  return false;
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
      ?.value || ""
  );
}

function extractBody(
  payload: gmail_v1.Schema$MessagePart | undefined
): string {
  if (!payload) return "";
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
    }
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }
  return "";
}

export interface IndexAllOptions {
  gmail: gmail_v1.Gmail;
  userEmail: string;
  query?: string;
  batchSize?: number;
  skipPromotional?: boolean;
  enrich?: boolean;
  onProgress?: (indexed: number, skipped: number, total: number) => void;
}

export async function indexAllEmails(
  opts: IndexAllOptions
): Promise<{ indexed: number; skipped: number; promotional_skipped: number; errors: number }> {
  const {
    gmail,
    userEmail,
    query,
    batchSize = 100,
    skipPromotional = false,
    enrich = false,
    onProgress,
  } = opts;

  let indexed = 0;
  let skipped = 0;
  let promoSkipped = 0;
  let errors = 0;
  let pageToken: string | undefined;
  let totalProcessed = 0;

  do {
    // List message IDs (up to batchSize per page)
    const listRes = await gmail.users.messages.list({
      userId: "me",
      maxResults: Math.min(batchSize, 500),
      ...(query ? { q: query } : {}),
      ...(pageToken ? { pageToken } : {}),
    });

    const messages = listRes.data.messages || [];
    pageToken = listRes.data.nextPageToken || undefined;

    for (const msg of messages) {
      totalProcessed++;

      try {
        // Quick dedup check before fetching full message
        const exists = await db.query(
          "SELECT 1 FROM emails WHERE id = $1",
          [msg.id]
        );
        if (exists.rows.length > 0) {
          skipped++;
          continue;
        }

        // Fetch full message
        const full = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "full",
        });

        const headers = full.data.payload?.headers;
        const from = getHeader(headers, "From");
        const to = getHeader(headers, "To");
        const subject = getHeader(headers, "Subject");
        const date = getHeader(headers, "Date");
        const snippet = full.data.snippet || "";
        const body = extractBody(full.data.payload);

        // Promotional filtering
        if (skipPromotional && isLikelyPromotional(from, headers)) {
          promoSkipped++;
          continue;
        }

        // Smart dedup by body hash
        const bodyHash = computeBodyHash(from, subject, body);

        const wasIndexed = await indexEmail({
          id: msg.id!,
          userEmail,
          threadId: full.data.threadId || "",
          subject,
          fromAddr: from,
          toAddr: to,
          date,
          snippet,
          bodyPreview: body.substring(0, 2000),
          bodyFull: body,
          bodyHash,
        });

        if (wasIndexed) {
          indexed++;

          // Auto-enrich if requested
          if (enrich) {
            await enrichEmail(msg.id!, subject, from, to, date, body);
            await new Promise((r) => setTimeout(r, 50)); // Rate limit
          }
        } else {
          skipped++;
        }
      } catch (err: any) {
        console.error(
          `[Indexing] Error processing message ${msg.id}:`,
          err.message
        );
        errors++;
      }

      // Progress callback
      if (onProgress && totalProcessed % 50 === 0) {
        onProgress(indexed, skipped, totalProcessed);
      }
    }
  } while (pageToken);

  return { indexed, skipped, promotional_skipped: promoSkipped, errors };
}
