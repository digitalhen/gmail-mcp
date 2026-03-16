import { db } from "./db.js";
import { consolidateProjects, assignOrphans, applyProjectMerge } from "./projects.js";

export async function assignProject(
  emailId: string,
  projectName: string
): Promise<{ message: string }> {
  // Get or create the project
  const projectResult = await db.query(
    `INSERT INTO projects (name, first_seen, last_activity)
     VALUES ($1, NOW(), NOW())
     ON CONFLICT (name) DO UPDATE SET last_activity = NOW()
     RETURNING id`,
    [projectName]
  );
  const projectId = projectResult.rows[0].id;

  // Get current project assignment for correction logging
  const current = await db.query(
    `SELECT p.name FROM email_projects ep
     JOIN projects p ON p.id = ep.project_id
     WHERE ep.email_id = $1`,
    [emailId]
  );
  const oldProject = current.rows[0]?.name || null;

  // Remove existing project assignments
  await db.query("DELETE FROM email_projects WHERE email_id = $1", [emailId]);

  // Assign to new project
  await db.query(
    `INSERT INTO email_projects (email_id, project_id, assigned_by, confidence)
     VALUES ($1, $2, 'manual', 1.0)
     ON CONFLICT DO NOTHING`,
    [emailId, projectId]
  );

  // Update enrichment
  await db.query(
    `UPDATE email_enrichment SET life_project = $1 WHERE email_id = $2`,
    [projectName, emailId]
  );

  // Log correction
  await db.query(
    `INSERT INTO enrichment_corrections (email_id, field, old_value, new_value)
     VALUES ($1, 'life_project', $2, $3)`,
    [emailId, oldProject, projectName]
  );

  return {
    message: `Assigned email ${emailId} to project "${projectName}"${oldProject ? ` (was: "${oldProject}")` : ""}`,
  };
}

export async function mergeProjects(
  fromName: string,
  toName: string
): Promise<{ message: string }> {
  await applyProjectMerge([fromName], toName);

  await db.query(
    `INSERT INTO enrichment_corrections (field, old_value, new_value)
     VALUES ('project_merge', $1, $2)`,
    [fromName, toName]
  );

  return {
    message: `Merged project "${fromName}" into "${toName}"`,
  };
}

export async function renameProject(
  oldName: string,
  newName: string
): Promise<{ message: string }> {
  await db.query("UPDATE projects SET name = $1 WHERE name = $2", [
    newName,
    oldName,
  ]);
  await db.query(
    "UPDATE email_enrichment SET life_project = $1 WHERE life_project = $2",
    [newName, oldName]
  );

  await db.query(
    `INSERT INTO enrichment_corrections (field, old_value, new_value)
     VALUES ('project_rename', $1, $2)`,
    [oldName, newName]
  );

  return { message: `Renamed project "${oldName}" to "${newName}"` };
}

export async function recluster(
  userEmail: string
): Promise<{
  consolidated: number;
  orphans_assigned: number;
  orphans_remaining: number;
  stale_completed: number;
}> {
  // 1. Consolidate duplicate projects
  const consolidation = await consolidateProjects(userEmail);

  // 2. Assign orphans
  const orphanResult = await assignOrphans(userEmail, 100);

  // 3. Mark stale projects as complete (no activity in 60 days)
  const staleResult = await db.query(
    `UPDATE projects SET status = 'completed'
     WHERE status = 'active'
       AND last_activity < NOW() - INTERVAL '60 days'
       AND id IN (
         SELECT DISTINCT ep.project_id FROM email_projects ep
         JOIN emails e ON e.id = ep.email_id
         WHERE e.user_email = $1
       )`,
    [userEmail]
  );

  return {
    consolidated: consolidation.merged,
    orphans_assigned: orphanResult.assigned,
    orphans_remaining: orphanResult.unassigned,
    stale_completed: staleResult.rowCount || 0,
  };
}

export async function enrichmentReview(userEmail: string) {
  // Get correction patterns
  const corrections = await db.query(
    `SELECT field, old_value, new_value, corrected_at
     FROM enrichment_corrections
     ORDER BY corrected_at DESC
     LIMIT 50`
  );

  // Get counts by type
  const correctionCounts = await db.query(
    `SELECT field, COUNT(*) as count
     FROM enrichment_corrections
     GROUP BY field
     ORDER BY count DESC`
  );

  // Get enrichment coverage
  const coverage = await db.query(
    `SELECT
       COUNT(*) as total_emails,
       COUNT(ee.email_id) as enriched,
       COUNT(CASE WHEN ee.embedding_enriched THEN 1 END) as reembedded,
       COUNT(ep.email_id) as with_project,
       COUNT(CASE WHEN ee.email_type = 'promotional' THEN 1 END) as promotional,
       COUNT(CASE WHEN ee.email_type = 'transactional' THEN 1 END) as transactional
     FROM emails e
     LEFT JOIN email_enrichment ee ON ee.email_id = e.id
     LEFT JOIN email_projects ep ON ep.email_id = e.id
     WHERE e.user_email = $1`,
    [userEmail]
  );

  return {
    coverage: coverage.rows[0],
    correction_counts: correctionCounts.rows,
    recent_corrections: corrections.rows,
  };
}
