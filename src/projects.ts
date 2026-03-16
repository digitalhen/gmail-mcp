import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db.js";
import { enrichEmail } from "./enrichment.js";

const anthropic = new Anthropic();

export async function consolidateProjects(
  userEmail: string
): Promise<{ merges: Array<{ from: string[]; to: string }>; merged: number }> {
  // Get all projects with counts
  const projects = await db.query(
    `SELECT p.id, p.name, COUNT(ep.email_id) as email_count
     FROM projects p
     JOIN email_projects ep ON ep.project_id = p.id
     JOIN emails e ON e.id = ep.email_id
     WHERE e.user_email = $1
     GROUP BY p.id
     ORDER BY email_count DESC`,
    [userEmail]
  );

  if (projects.rows.length < 2) {
    return { merges: [], merged: 0 };
  }

  const projectList = projects.rows
    .map((p: any) => `- "${p.name}" (${p.email_count} emails)`)
    .join("\n");

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are merging duplicate/variant project names in a personal email knowledge graph.

Here are all current projects:
${projectList}

Identify groups that should be merged (same project, different naming). Respond ONLY in JSON, no backticks:

{
  "merges": [
    {"from": ["variant name 1", "variant name 2"], "to": "canonical name"}
  ]
}

Rules:
- Only merge if they clearly refer to the same real-world project
- Pick the most descriptive canonical name
- If no merges needed, return {"merges": []}
- Be conservative — don't merge unrelated projects`,
      },
    ],
  });

  const responseText =
    message.content[0].type === "text" ? message.content[0].text : "{}";
  let cleaned = responseText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const result = JSON.parse(cleaned);
  let totalMerged = 0;

  for (const merge of result.merges || []) {
    await applyProjectMerge(merge.from, merge.to);
    totalMerged += merge.from.length;
  }

  return { merges: result.merges || [], merged: totalMerged };
}

export async function applyProjectMerge(
  fromNames: string[],
  toName: string
): Promise<void> {
  await db.transaction(async (client) => {
    // Get or create the target project
    const targetResult = await client.query(
      `INSERT INTO projects (name, first_seen, last_activity)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (name) DO UPDATE SET last_activity = NOW()
       RETURNING id`,
      [toName]
    );
    const targetId = targetResult.rows[0].id;

    // Get source project IDs
    const sources = await client.query(
      "SELECT id FROM projects WHERE name = ANY($1)",
      [fromNames]
    );

    for (const source of sources.rows) {
      if (source.id === targetId) continue;

      // Move email_projects links
      await client.query(
        `UPDATE email_projects SET project_id = $1
         WHERE project_id = $2
         AND email_id NOT IN (SELECT email_id FROM email_projects WHERE project_id = $1)`,
        [targetId, source.id]
      );

      // Delete remaining duplicates
      await client.query(
        "DELETE FROM email_projects WHERE project_id = $1",
        [source.id]
      );

      // Update enrichment references
      await client.query(
        "UPDATE email_enrichment SET life_project = $1 WHERE life_project = $2",
        [toName, fromNames.find((n) => true)]
      );

      // Delete source project
      await client.query("DELETE FROM projects WHERE id = $1", [source.id]);
    }
  });
}

export async function assignOrphans(
  userEmail: string,
  maxResults: number
): Promise<{ assigned: number; unassigned: number }> {
  // Find emails with enrichment but no project
  const orphans = await db.query(
    `SELECT e.id, e.subject, e.from_addr, e.snippet, ee.intent_summary
     FROM emails e
     JOIN email_enrichment ee ON ee.email_id = e.id
     LEFT JOIN email_projects ep ON ep.email_id = e.id
     WHERE e.user_email = $1
       AND ep.email_id IS NULL
       AND ee.life_project IS NULL
       AND ee.email_type NOT IN ('promotional', 'transactional')
     LIMIT $2`,
    [userEmail, maxResults]
  );

  if (orphans.rows.length === 0) {
    return { assigned: 0, unassigned: 0 };
  }

  let assigned = 0;
  let unassigned = 0;

  // Try entity overlap assignment first
  for (const orphan of orphans.rows) {
    // Find projects that share entities with this email
    const entityMatch = await db.query(
      `SELECT p.id, p.name, COUNT(DISTINCT ee2.entity_id) as shared
       FROM email_entities ee1
       JOIN email_entities ee2 ON ee2.entity_id = ee1.entity_id
       JOIN email_projects ep ON ep.email_id = ee2.email_id
       JOIN projects p ON p.id = ep.project_id
       WHERE ee1.email_id = $1 AND ee2.email_id != $1
       GROUP BY p.id
       HAVING COUNT(DISTINCT ee2.entity_id) >= 2
       ORDER BY shared DESC
       LIMIT 1`,
      [orphan.id]
    );

    if (entityMatch.rows.length > 0) {
      await db.query(
        `INSERT INTO email_projects (email_id, project_id, assigned_by)
         VALUES ($1, $2, 'entity_overlap')
         ON CONFLICT DO NOTHING`,
        [orphan.id, entityMatch.rows[0].id]
      );
      assigned++;
    } else {
      unassigned++;
    }
  }

  return { assigned, unassigned };
}

export async function listProjects(userEmail: string) {
  const result = await db.query(
    `SELECT p.id, p.name, p.status, p.description,
            COUNT(ep.email_id) as email_count,
            MIN(e.date) as first_email,
            MAX(e.date) as last_email,
            p.first_seen, p.last_activity
     FROM projects p
     JOIN email_projects ep ON ep.project_id = p.id
     JOIN emails e ON e.id = ep.email_id
     WHERE e.user_email = $1
     GROUP BY p.id
     ORDER BY email_count DESC`,
    [userEmail]
  );
  return result.rows;
}

export async function projectEmails(
  userEmail: string,
  projectName: string,
  limit: number
) {
  const result = await db.query(
    `SELECT e.id, e.subject, e.from_addr, e.to_addr, e.date, e.snippet,
            ee.intent_summary, ee.sentiment
     FROM emails e
     JOIN email_projects ep ON ep.email_id = e.id
     JOIN projects p ON p.id = ep.project_id
     LEFT JOIN email_enrichment ee ON ee.email_id = e.id
     WHERE e.user_email = $1 AND p.name = $2
     ORDER BY e.date DESC
     LIMIT $3`,
    [userEmail, projectName, limit]
  );
  return result.rows;
}

export async function projectSummary(
  userEmail: string,
  projectName: string
): Promise<string> {
  const emails = await projectEmails(userEmail, projectName, 30);

  if (emails.length === 0) {
    return `No emails found for project "${projectName}".`;
  }

  const emailList = emails
    .map(
      (e: any, i: number) =>
        `${i + 1}. [${e.date}] From: ${e.from_addr} — ${e.subject}\n   Intent: ${e.intent_summary || e.snippet}`
    )
    .join("\n");

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Summarize this email project "${projectName}" for a personal knowledge graph. Write 2-4 paragraphs covering: what this project is about, who's involved, key dates/events, and current status.

Emails (most recent first):
${emailList}`,
      },
    ],
  });

  return message.content[0].type === "text"
    ? message.content[0].text
    : "Unable to generate summary.";
}
