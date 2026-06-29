#!/usr/bin/env tsx
/**
 * Smoke test for LangGraph interrupt/resume with MemorySaver.
 *
 * Uses a synthetic two-node graph (no API calls) to verify that:
 *   1. A graph invoking interrupt() pauses and returns to the caller
 *   2. The graph can be resumed with Command({ resume: value })
 *   3. The resumed value is received by the node that called interrupt()
 *
 * This is the mechanism that planning cell humanApprovalGate will use.
 * No external services needed.
 */

import assert from "node:assert/strict";
import { Annotation, Command, interrupt, MemorySaver, StateGraph } from "@langchain/langgraph";

// ---- Minimal test graph ----

const TestState = Annotation.Root({
  step:        Annotation<string>({ default: () => "init",  reducer: (_, v) => v }),
  resumeValue: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
});

type S = typeof TestState.State;

async function waitForApproval(state: S): Promise<Partial<S>> {
  // This call pauses the graph until Command({ resume: ... }) is sent.
  const value: string = interrupt({
    prompt: "Provide approval to continue",
    step: state.step,
  });
  return { step: "approved", resumeValue: value };
}

async function afterApproval(_state: S): Promise<Partial<S>> {
  return { step: "done" };
}

const testGraph = new StateGraph(TestState)
  .addNode("waitForApproval", waitForApproval)
  .addNode("afterApproval",   afterApproval)
  .addEdge("__start__",       "waitForApproval")
  .addEdge("waitForApproval", "afterApproval")
  .addEdge("afterApproval",   "__end__");

// ---- Test runner ----

async function main(): Promise<void> {
  console.log("=== LangGraph interrupt/resume smoke test ===\n");

  const checkpointer = new MemorySaver();
  const workflow = testGraph.compile({ checkpointer, interruptBefore: [] });
  const config = { configurable: { thread_id: "smoke-interrupt-1" } };

  // --- Step 1: first invoke should pause at waitForApproval ---
  console.log("Step 1: Invoking — expecting interrupt at waitForApproval...");
  await workflow.invoke({ step: "init" }, config);

  const snapshotAfterFirst = await workflow.getState(config);
  const tasks = snapshotAfterFirst.tasks ?? [];
  const interrupted = tasks.some(
    (t: { interrupts?: unknown[] }) => Array.isArray(t.interrupts) && t.interrupts.length > 0
  );

  assert.ok(
    interrupted || snapshotAfterFirst.next.length > 0,
    `Expected graph to be paused (interrupted or pending), but next=${JSON.stringify(snapshotAfterFirst.next)}`
  );

  const interruptedTask = tasks.find(
    (t: { interrupts?: unknown[] }) => Array.isArray(t.interrupts) && t.interrupts.length > 0
  );
  const interruptPayload = (interruptedTask as { interrupts?: Array<{ value: unknown }> } | undefined)?.interrupts?.[0]?.value;

  console.log(`  [PASS] Graph paused. Interrupt payload: ${JSON.stringify(interruptPayload)}`);
  console.log(`  Next nodes: ${snapshotAfterFirst.next.join(", ")}`);

  // --- Step 2: resume with approval value ---
  console.log("\nStep 2: Resuming with 'approved'...");
  const finalState = await workflow.invoke(new Command({ resume: "approved" }), config);

  assert.equal(finalState.step, "done",
    `Expected step='done' after resume, got '${finalState.step}'`);
  assert.equal(finalState.resumeValue, "approved",
    `Expected resumeValue='approved', got '${finalState.resumeValue}'`);

  const snapshotAfterResume = await workflow.getState(config);
  assert.equal(snapshotAfterResume.next.length, 0,
    "Expected no pending nodes after graph completes");

  console.log("  [PASS] Graph completed. Final state:", finalState);
  console.log("  [PASS] No pending nodes after completion.\n");

  console.log("=== interrupt/resume test PASSED ===");
  console.log("\nTo wire this into the planning cell:");
  console.log("  1. Compile planningWorkflow with a PostgresSaver (for durability across process restarts)");
  console.log("  2. Pass { configurable: { thread_id: agentRunId } } to invoke()");
  console.log("  3. Detect interrupt via workflow.getState(config).tasks[*].interrupts");
  console.log("  4. Resume with: workflow.invoke(new Command({ resume: approvalInput }), config)");
  console.log("  5. Store the thread_id in the task record so the approval endpoint can find it");
}

main().catch((err) => {
  console.error("[FAIL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
