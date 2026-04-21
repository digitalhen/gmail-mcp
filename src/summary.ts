// Local-LLM classifier + summarizer via Ollama.
// Produces a classification and a short "what this email IS" sentence,
// then the caller embeds the summary instead of the raw body. This
// fixes the marketing-email-ranks-high problem because the summary
// says *what the email is*, not what words it contains — a Kayak
// travel newsletter summarizes as "marketing email promoting
// destinations" (semantically far from "Montreal flight confirmation").

export type EmailSummary = {
  type: "transactional" | "promotional" | "personal" | "notification" | "newsletter" | "other";
  summary: string;
  is_promotional: boolean;
  is_transactional: boolean;
};

const SYSTEM_PROMPT = `You classify and summarize emails. Return ONLY a JSON object, no preamble, no markdown.

Schema:
{
  "type": "transactional" | "promotional" | "personal" | "notification" | "newsletter" | "other",
  "summary": "One short sentence describing what this email IS and its purpose. Focus on intent, not vocabulary.",
  "is_promotional": boolean,
  "is_transactional": boolean
}

Rules:
- "summary" should capture WHAT the email is (a booking confirmation, a marketing blast, a personal note) not what words appear in it. Example:
  - Good: "Flight confirmation for booking JGZPDK to Montreal on 2026-04-07"
  - Bad:  "Email about travel to Montreal"
  - Good: "Marketing newsletter from Kayak promoting European travel destinations"
  - Bad:  "Email mentioning Notre-Dame and travel deals"
- Include concrete identifiers in the summary when present (booking codes, dates, names, amounts).
- is_promotional = true for marketing/sales/newsletter content.
- is_transactional = true for receipts, confirmations, bills, statements, shipping.
- A single email can be both false (e.g. personal note) but rarely both true.
- Keep the summary under 25 words.`;

type Options = {
  url?: string;
  model?: string;
  timeoutMs?: number;
};

export async function summarizeEmail(
  email: {
    subject: string;
    from: string;
    snippet: string;
    bodyPreview: string;
    date: string;
  },
  opts: Options = {}
): Promise<EmailSummary> {
  const url = (opts.url || process.env.OLLAMA_URL || "http://host.docker.internal:11434").replace(/\/+$/, "");
  const model = opts.model || process.env.OLLAMA_LLM_MODEL || "qwen3.5:latest";
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const bodySnippet = (email.bodyPreview || "").slice(0, 1500);

  const userContent = `From: ${email.from || "(unknown)"}
Subject: ${email.subject || "(no subject)"}
Date: ${email.date || ""}
Snippet: ${email.snippet || ""}
Body: ${bodySnippet}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        stream: false,
        format: "json",
        options: { temperature: 0 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama chat ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    const raw = data.message?.content || "";
    return parseSummary(raw);
  } finally {
    clearTimeout(t);
  }
}

function parseSummary(raw: string): EmailSummary {
  // Some models wrap in ``` fences despite format=json; strip defensively.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let obj: any;
  try {
    obj = JSON.parse(cleaned);
  } catch (e) {
    // Try to extract the first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Summary LLM returned non-JSON: ${raw.slice(0, 200)}`);
    obj = JSON.parse(match[0]);
  }

  const type = normalizeType(obj.type);
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const is_promotional = Boolean(obj.is_promotional);
  const is_transactional = Boolean(obj.is_transactional);

  if (!summary) throw new Error("Summary LLM returned empty summary");

  return { type, summary, is_promotional, is_transactional };
}

function normalizeType(raw: any): EmailSummary["type"] {
  if (typeof raw !== "string") return "other";
  const v = raw.toLowerCase().trim();
  const valid = ["transactional", "promotional", "personal", "notification", "newsletter", "other"];
  return valid.includes(v) ? (v as EmailSummary["type"]) : "other";
}

// The text we actually pass to the embedding model. Prefixing with the
// type means semantically different categories (e.g. promotional vs
// transactional) land in different regions of vector space.
export function embeddingTextFromSummary(
  s: EmailSummary,
  email: { from: string; subject: string }
): string {
  return `[${s.type}] ${s.summary} From: ${email.from || ""} Subject: ${email.subject || ""}`;
}
