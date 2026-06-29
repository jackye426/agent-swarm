#!/usr/bin/env tsx
// Validates all evidence records under task evidence directories.
// Exit 1 if any evidence record fails or if any acceptance criterion lacks passing evidence.

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import {
  EvidenceRecordSchema,
  TaskContractSchema,
  checkCriteriaFullyCovered,
  validateEvidenceAgainstContract,
  type ValidatedContract,
  type ValidatedEvidence,
} from "../src/core/schemas.js";

const TASKS_DIR = path.resolve("tasks");
let hasErrors = false;

function loadContract(taskDir: string): ValidatedContract | null {
  const contractPath = path.join(taskDir, "contract.yaml");
  if (!fs.existsSync(contractPath)) return null;

  const raw = fs.readFileSync(contractPath, "utf8");
  const parsed = yaml.load(raw);
  const result = TaskContractSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function validateEvidence(
  filePath: string,
  taskId: string,
  contract: ValidatedContract
): ValidatedEvidence | null {
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;

  try {
    parsed = yaml.load(raw);
  } catch (e) {
    console.error(`[FAIL] ${filePath}: YAML parse error - ${(e as Error).message}`);
    hasErrors = true;
    return null;
  }

  const result = EvidenceRecordSchema.safeParse(parsed);
  if (!result.success) {
    console.error(`[FAIL] ${filePath}:`);
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")} - ${issue.message}`);
    }
    hasErrors = true;
    return null;
  }

  const evidence = result.data;
  const expectedEvidenceId = path.basename(filePath).replace(/\.(yaml|yml)$/i, "");

  if (evidence.evidence_id !== expectedEvidenceId) {
    console.error(
      `[FAIL] ${filePath}: evidence_id "${evidence.evidence_id}" does not match filename "${expectedEvidenceId}"`
    );
    hasErrors = true;
    return null;
  }

  if (evidence.task_id !== taskId) {
    console.error(`[FAIL] ${filePath}: task_id "${evidence.task_id}" does not match directory "${taskId}"`);
    hasErrors = true;
    return null;
  }

  const crossErrors = validateEvidenceAgainstContract(evidence, contract);
  if (crossErrors.length > 0) {
    console.error(`[FAIL] ${filePath}:`);
    for (const e of crossErrors) console.error(`  ${e}`);
    hasErrors = true;
    return null;
  }

  console.log(`[PASS] ${filePath} (${evidence.evidence_id} -> ${evidence.acceptance_criteria.join(", ")})`);
  return evidence;
}

if (!fs.existsSync(TASKS_DIR)) {
  console.error("No tasks/ directory found");
  process.exit(1);
}

const taskDirs = fs
  .readdirSync(TASKS_DIR)
  .filter((d) => /^T-\d+$/.test(d));

if (taskDirs.length === 0) {
  console.error("No task directories found under tasks/");
  process.exit(1);
}

for (const taskId of taskDirs) {
  const taskDir = path.join(TASKS_DIR, taskId);
  const contract = loadContract(taskDir);
  const evidenceList: ValidatedEvidence[] = [];

  if (!contract) {
    console.error(`[FAIL] ${taskDir}: cannot load valid contract`);
    hasErrors = true;
    continue;
  }

  const evidenceDir = path.join(taskDir, "evidence");
  if (!fs.existsSync(evidenceDir)) {
    console.error(`[FAIL] ${taskId}: missing evidence directory`);
    hasErrors = true;
    continue;
  }

  const files = fs
    .readdirSync(evidenceDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

  if (files.length === 0) {
    console.error(`[FAIL] ${taskId}: no evidence files found`);
    hasErrors = true;
  }

  for (const file of files) {
    const evidence = validateEvidence(path.join(evidenceDir, file), taskId, contract);
    if (evidence) evidenceList.push(evidence);
  }

  const { missing } = checkCriteriaFullyCovered(contract, evidenceList);
  if (missing.length > 0) {
    console.error(`[FAIL] ${taskId}: missing passing evidence for ${missing.join(", ")}`);
    hasErrors = true;
  }
}

if (hasErrors) {
  console.error("\nEvidence validation failed.");
  process.exit(1);
}

console.log("\nAll evidence valid.");
