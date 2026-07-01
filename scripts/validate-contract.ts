#!/usr/bin/env tsx
// Validates all task contracts under task directories.
// Exit 1 if any contract fails schema validation.

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { TaskContractSchema } from "../src/core/schemas.js";
import { validateContractExecutability } from "../src/core/contract-executability.js";

const TASKS_DIR = path.resolve("tasks");
const strictMode = process.argv.includes("--strict");
let hasErrors = false;

function validateFile(filePath: string, expectedTaskId: string): void {
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    console.error(`[FAIL] ${filePath}: YAML parse error — ${(e as Error).message}`);
    hasErrors = true;
    return;
  }

  const result = TaskContractSchema.safeParse(parsed);
  if (!result.success) {
    console.error(`[FAIL] ${filePath}:`);
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")} — ${issue.message}`);
    }
    hasErrors = true;
  } else {
    // Ensure every acceptance criterion has at least one verification method
    const contract = result.data;
    let fileHasErrors = false;

    if (contract.id !== expectedTaskId) {
      console.error(`[FAIL] ${filePath}: contract id "${contract.id}" does not match directory "${expectedTaskId}"`);
      hasErrors = true;
      fileHasErrors = true;
    }

    for (const ac of contract.acceptance_criteria) {
      if (ac.verification.length === 0) {
        console.error(`[FAIL] ${filePath}: ${ac.id} has no verification methods`);
        hasErrors = true;
        fileHasErrors = true;
      }
    }

    if (strictMode && !fileHasErrors) {
      const execResult = validateContractExecutability(contract, { requireCommandAc: true });
      if (!execResult.ok) {
        console.error(`[FAIL] ${filePath}: executability validation failed`);
        for (const err of execResult.errors) {
          console.error(`  ${err}`);
        }
        hasErrors = true;
        fileHasErrors = true;
      }
    }

    if (!fileHasErrors) {
      console.log(`[PASS] ${filePath} (${contract.id}: ${contract.title})`);
    }
  }
}

if (!fs.existsSync(TASKS_DIR)) {
  console.error("No tasks/ directory found");
  process.exit(1);
}

const taskDirs = fs
  .readdirSync(TASKS_DIR)
  .filter((d) => /^T-\d+$/.test(d))
  .map((d) => path.join(TASKS_DIR, d));

if (taskDirs.length === 0) {
  console.error("No task directories found under tasks/");
  process.exit(1);
}

for (const dir of taskDirs) {
  const contractPath = path.join(dir, "contract.yaml");
  const taskId = path.basename(dir);
  if (!fs.existsSync(contractPath)) {
    console.error(`[FAIL] ${dir}: missing contract.yaml`);
    hasErrors = true;
    continue;
  }
  validateFile(contractPath, taskId);
}

if (hasErrors) {
  console.error("\nContract validation failed.");
  process.exit(1);
} else {
  console.log("\nAll contracts valid.");
}
