#!/usr/bin/env tsx

import { db } from "../src/db/client.js";

const taskId = process.argv[2] ?? "T-002";

async function main(): Promise<void> {
  const [taskRes, runsRes, artifactsRes, evidenceRes, verificationRes] = await Promise.all([
    db
      .from("tasks")
      .select("id,title,status,cell,contract_version,updated_at")
      .eq("id", taskId)
      .single(),
    db
      .from("agent_runs")
      .select("id,cell,worker_type,status,started_at,completed_at")
      .eq("task_id", taskId)
      .order("started_at", { ascending: false })
      .limit(5),
    db
      .from("artifacts")
      .select("artifact_type,created_at")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true }),
    db
      .from("evidence_records")
      .select("id,evidence_type,status,acceptance_criteria,commit_sha,recorded_at")
      .eq("task_id", taskId)
      .order("recorded_at", { ascending: true }),
    db
      .from("verification_records")
      .select("id,verdict,blocking_defects,missing_evidence,criterion_verdicts,created_at")
      .eq("task_id", taskId)
      .order("created_at", { ascending: false })
      .limit(3),
  ]);

  if (taskRes.error) throw new Error(`Failed to load task ${taskId}: ${taskRes.error.message}`);
  if (runsRes.error) throw new Error(`Failed to load agent runs: ${runsRes.error.message}`);
  if (artifactsRes.error) throw new Error(`Failed to load artifacts: ${artifactsRes.error.message}`);
  if (evidenceRes.error) throw new Error(`Failed to load evidence records: ${evidenceRes.error.message}`);
  if (verificationRes.error) throw new Error(`Failed to load verification records: ${verificationRes.error.message}`);

  console.log(JSON.stringify({
    task: taskRes.data,
    runs: runsRes.data,
    artifacts: artifactsRes.data,
    evidence: evidenceRes.data,
    verification: verificationRes.data,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
