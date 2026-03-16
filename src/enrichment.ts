import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db.js";

const anthropic = new Anthropic(); // uses ANTHROPIC_API_KEY env var

const ENRICHMENT_PROMPT = `You are an email metadata extraction engine for a personal email knowledge graph. The user is Henry Williams, based in Brooklyn, NY.

Given an email, extract structured metadata. Consider the full context: who the participants are, what life event or project this relates to, and how it connects to other activities in someone's life.

Respond ONLY in JSON. No markdown, no preamble, no backticks.

{
  "intent_summary": "One sentence: what is this email about in the context of someone's life?",
  "life_project": "Short name for the broader project/initiative (e.g., 'London Trip March 2026', 'Snowball Vet Care', 'CNN Job Application', 'Passport Applications'). Use consistent naming. Null if purely transactional/promotional.",
  "entities": [
    {
      "name": "Full name or proper noun",
      "type": "person|place|organization|flight|document|event|institution",
      "role": "sender|recipient|mentioned|location|destination|provider|subject"
    }
  ],
  "topics": ["up to 5 tags from: travel, coparenting, medical, legal, career, finance, technology, family, school, home, civic, insurance, food, shopping, media, passport, immigration"],
  "key_dates": [
    {"date": "YYYY-MM-DD", "description": "what happens on this date"}
  ],
  "sentiment": "positive|negative|neutral|urgent|confrontational",
  "email_type": "personal|professional|transactional|promotional|notification|legal"
}

Rules:
- For flight bookings, extract: airline, flight number, origin, destination, dates, all passenger names
- For appointment emails, extract: provider, patient/client, date, type of appointment
- For co-parenting emails, always extract: children mentioned, dates discussed, locations
- Use CONSISTENT project names across emails (don't create variants like 'UK Trip' and 'London Trip')
- Promotional/marketing emails: set life_project to null, email_type to "promotional"
- Be specific with intent_summary: "Booking family flight to London" not "Travel email"`;

interface EnrichmentResult {
  intent_summary: string;
  life_project: string | null;
  entities: Array<{
    name: string;
    type: string;
    role: string;
  }>;
  topics: string[];
  key_dates: Array<{
    date: string;
    description: string;
  }>;
  sentiment: string;
  email_type: string;
}

function parseEnrichmentResponse(text: string): EnrichmentResult {
  // Strip markdown fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return JSON.parse(cleaned);
}

export async function enrichEmail(
  emailId: string,
  subject: string,
  from: string,
  to: string,
  date: string,
  body: string
): Promise<EnrichmentResult | null> {
  try {
    const emailText = `From: ${from}
To: ${to}
Date: ${date}
Subject: ${subject}

${body}`;

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `${ENRICHMENT_PROMPT}\n\n---\n\n${emailText}`,
        },
      ],
    });

    const responseText =
      message.content[0].type === "text" ? message.content[0].text : "";
    const enrichment = parseEnrichmentResponse(responseText);

    // Write to Postgres in a transaction
    await db.transaction(async (client) => {
      // 1. Insert email_enrichment
      await client.query(
        `INSERT INTO email_enrichment (email_id, intent_summary, life_project, sentiment, email_type, is_transactional, is_promotional, enrichment_model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (email_id) DO UPDATE SET
           intent_summary = EXCLUDED.intent_summary,
           life_project = EXCLUDED.life_project,
           sentiment = EXCLUDED.sentiment,
           email_type = EXCLUDED.email_type,
           is_transactional = EXCLUDED.is_transactional,
           is_promotional = EXCLUDED.is_promotional,
           enrichment_model = EXCLUDED.enrichment_model,
           enriched_at = NOW()`,
        [
          emailId,
          enrichment.intent_summary,
          enrichment.life_project,
          enrichment.sentiment,
          enrichment.email_type,
          enrichment.email_type === "transactional",
          enrichment.email_type === "promotional",
          "claude-haiku-4-5-20251001",
        ]
      );

      // 2. Insert entities and link to email
      for (const entity of enrichment.entities || []) {
        const canonicalName = entity.name.toLowerCase().trim();

        // Upsert entity
        const entityResult = await client.query(
          `INSERT INTO entities (name, entity_type, canonical_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (canonical_name, entity_type) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [entity.name, entity.type, canonicalName]
        );

        const entityId = entityResult.rows[0].id;

        // Link entity to email
        await client.query(
          `INSERT INTO email_entities (email_id, entity_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [emailId, entityId, entity.role]
        );
      }

      // 3. Insert tags
      for (const tag of enrichment.topics || []) {
        await client.query(
          `INSERT INTO email_tags (email_id, tag)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [emailId, tag]
        );
      }

      // 4. Insert/update project if present
      if (enrichment.life_project) {
        const projectResult = await client.query(
          `INSERT INTO projects (name, first_seen, last_activity)
           VALUES ($1, NOW(), NOW())
           ON CONFLICT (name) DO UPDATE SET last_activity = NOW()
           RETURNING id`,
          [enrichment.life_project]
        );

        const projectId = projectResult.rows[0].id;

        await client.query(
          `INSERT INTO email_projects (email_id, project_id, assigned_by)
           VALUES ($1, $2, 'llm')
           ON CONFLICT DO NOTHING`,
          [emailId, projectId]
        );
      }
    });

    return enrichment;
  } catch (error: any) {
    console.error(
      `[Enrichment] Failed to enrich email ${emailId}:`,
      error.message
    );
    return null;
  }
}

export async function getEnrichmentStats(userEmail: string) {
  const totalEmails = await db.query(
    "SELECT COUNT(*) as count FROM emails WHERE user_email = $1",
    [userEmail]
  );

  const enrichedEmails = await db.query(
    `SELECT COUNT(*) as count FROM email_enrichment ee
     JOIN emails e ON ee.email_id = e.id
     WHERE e.user_email = $1`,
    [userEmail]
  );

  const topProjects = await db.query(
    `SELECT p.name, COUNT(ep.email_id) as email_count, p.last_activity, p.status
     FROM projects p
     JOIN email_projects ep ON ep.project_id = p.id
     JOIN emails e ON e.id = ep.email_id
     WHERE e.user_email = $1
     GROUP BY p.id
     ORDER BY email_count DESC
     LIMIT 15`,
    [userEmail]
  );

  const topEntities = await db.query(
    `SELECT en.name, en.entity_type, COUNT(DISTINCT ee.email_id) as email_count
     FROM entities en
     JOIN email_entities ee ON ee.entity_id = en.id
     JOIN emails e ON e.id = ee.email_id
     WHERE e.user_email = $1
     GROUP BY en.id
     ORDER BY email_count DESC
     LIMIT 15`,
    [userEmail]
  );

  const topTags = await db.query(
    `SELECT et.tag, COUNT(*) as count
     FROM email_tags et
     JOIN emails e ON e.id = et.email_id
     WHERE e.user_email = $1
     GROUP BY et.tag
     ORDER BY count DESC
     LIMIT 10`,
    [userEmail]
  );

  const sentimentBreakdown = await db.query(
    `SELECT ee.sentiment, COUNT(*) as count
     FROM email_enrichment ee
     JOIN emails e ON ee.email_id = e.id
     WHERE e.user_email = $1
     GROUP BY ee.sentiment
     ORDER BY count DESC`,
    [userEmail]
  );

  return {
    total_emails: parseInt(totalEmails.rows[0].count),
    enriched_emails: parseInt(enrichedEmails.rows[0].count),
    unenriched_emails:
      parseInt(totalEmails.rows[0].count) -
      parseInt(enrichedEmails.rows[0].count),
    projects: topProjects.rows,
    top_entities: topEntities.rows,
    top_tags: topTags.rows,
    sentiment_breakdown: sentimentBreakdown.rows,
  };
}
