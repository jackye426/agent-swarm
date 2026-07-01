import { StateGraph, Annotation, MemorySaver } from "@langchain/langgraph";

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

import type { TaskContract } from "../../core/types.js";

import { TaskContractSchema } from "../../core/schemas.js";

import {

  executabilityContextFromPacket,

  formatCompactContextForReview,

  validateContractExecutability,

} from "../../core/contract-executability.js";

import { invokeRoleModel } from "../../core/model-router.js";

import {

  dependenciesComplete,

  enrichExecutionContextPacket,

  getLatestContextPacket,

  publishContractVersion,

  recordApproval,

  recordArtifact,

} from "../../db/records.js";

import { transitionTaskStatus } from "../../db/tasks.js";



// ---- State ----



const PlanningState = Annotation.Root({

  taskId:         Annotation<string>(),

  agentRunId:     Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),

  goal:           Annotation<string>(),

  context:        Annotation<string>(),        // serialised context packet

  stopAfterDraft: Annotation<boolean>({ default: () => false, reducer: (_, v) => v }),

  planA:          Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),

  planB:          Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),

  planAReview:    Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),

  planBReview:    Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),

  consensus:      Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),

  draftContract:  Annotation<Partial<TaskContract> | null>({ default: () => null, reducer: (_, v) => v }),

  error:          Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),

});



type S = typeof PlanningState.State;



function compactContext(state: S): string {

  return formatCompactContextForReview(state.context);

}



function groundedReviewUserMessage(state: S, body: string): string {

  return `Goal: ${state.goal}



Repo context:

${compactContext(state)}



${body}`;

}



const GROUNDING_SYSTEM_LINE =

  "Ground critiques in the goal and repo context above, not just plan-to-plan comparison.";



const CONTRACT_DRAFT_VERIFICATION_RULES = `

Acceptance criterion verification methods MUST be pipeline-executable:

- GOOD command examples: "npm test", "npm run typecheck", "npm run validate"

- GOOD diff-inspection examples: "Inspect PR diff for .github/workflows/ci.yml", "File presence check in PR diff"

- BAD (do not use): "Manual review by Engineering Owner", "Works as expected", "Verify functionality"

- Every AC needs at least one command OR diff-inspection method

- Prefer detected test commands from the repo context when listing command methods`;



// ---- Nodes ----



async function producePlanA(state: S): Promise<Partial<S>> {

  const planA = await invokeRoleModel("planning_a", [

    {

      role: "system",

      content: `You are a senior engineering planner. Produce an independent, detailed implementation plan.

Output a structured plan with: approach, scope, risks, sequencing, and test strategy.

Be concrete and specific. Do not pad.`,

    },

    {

      role: "user",

      content: `Goal: ${state.goal}\n\nContext:\n${state.context}`,

    },

  ], { temperature: 0.2 });

  await recordArtifact({

    taskId: state.taskId,

    artifactType: "planning_plan_a",

    content: { agent_run_id: state.agentRunId, text: planA },

  });

  return { planA };

}



async function producePlanB(state: S): Promise<Partial<S>> {

  const planB = await invokeRoleModel("planning_b", [

    {

      role: "system",

      content: `You are an independent engineering planner. You have NOT seen Plan A.

Produce an independent plan covering: approach, scope, risks, sequencing, and test strategy.

Be concrete and focus on what Plan A might have missed.`,

    },

    {

      role: "user",

      content: `Goal: ${state.goal}\n\nContext:\n${state.context}`,

    },

  ], { temperature: 0.35 });

  await recordArtifact({

    taskId: state.taskId,

    artifactType: "planning_plan_b",

    content: { agent_run_id: state.agentRunId, text: planB },

  });

  return { planB };

}



async function reviewPlanBAsA(state: S): Promise<Partial<S>> {

  const planAReview = await invokeRoleModel("planning_a_review", [

    {

      role: "system",

      content: `You are Planner A reviewing Planner B's plan.

You must defend your own plan where it is stronger, adopt Planner B's ideas where they are better,

and identify disagreements that must be resolved before a task contract is drafted.

${GROUNDING_SYSTEM_LINE}

Output: adopted ideas, rejected ideas with reasons, unresolved disagreements, risk updates, and your revised recommendation.`,

    },

    {

      role: "user",

      content: groundedReviewUserMessage(

        state,

        `Original Plan A:\n${state.planA}\n\nPlanner B Plan:\n${state.planB}`,

      ),

    },

  ], { temperature: 0.1 });

  await recordArtifact({

    taskId: state.taskId,

    artifactType: "planning_a_review_of_b",

    content: { agent_run_id: state.agentRunId, text: planAReview },

  });

  return { planAReview };

}



async function reviewPlanAAsB(state: S): Promise<Partial<S>> {

  const planBReview = await invokeRoleModel("planning_b_review", [

    {

      role: "system",

      content: `You are Planner B reviewing Planner A's plan.

You must defend your own plan where it is stronger, adopt Planner A's ideas where they are better,

and identify disagreements that must be resolved before a task contract is drafted.

${GROUNDING_SYSTEM_LINE}

Output: adopted ideas, rejected ideas with reasons, unresolved disagreements, risk updates, and your revised recommendation.`,

    },

    {

      role: "user",

      content: groundedReviewUserMessage(

        state,

        `Original Plan B:\n${state.planB}\n\nPlanner A Plan:\n${state.planA}`,

      ),

    },

  ], { temperature: 0.1 });

  await recordArtifact({

    taskId: state.taskId,

    artifactType: "planning_b_review_of_a",

    content: { agent_run_id: state.agentRunId, text: planBReview },

  });

  return { planBReview };

}



async function synthesizeConsensus(state: S): Promise<Partial<S>> {

  const consensus = await invokeRoleModel("planning_consensus", [

    {

      role: "system",

      content: `You are a planning chair synthesizing two independent plans and their peer reviews.

Arrive at a consensus plan suitable for an evidence-gated task contract.

Reconcile plans against the stated goal and repo context — do not adopt assumptions contradicted by the codebase.

Do not average weak ideas. Prefer the best-supported plan elements.

Output these sections:

1. Consensus summary

2. Adopted decisions

3. Rejected alternatives and why

4. Resolved disagreements

5. Unresolved risks requiring human approval

6. Task sequencing and dependency map

7. Acceptance criteria and evidence strategy

8. Rollback strategy`,

    },

    {

      role: "user",

      content: groundedReviewUserMessage(

        state,

        `Plan A:\n${state.planA}



Plan B:

${state.planB}



Planner A review of Plan B:

${state.planAReview}



Planner B review of Plan A:

${state.planBReview}`,

      ),

    },

  ], { temperature: 0.1 });

  await recordArtifact({

    taskId: state.taskId,

    artifactType: "planning_consensus",

    content: { agent_run_id: state.agentRunId, text: consensus },

  });

  return { consensus };

}



async function generateDraftContract(state: S): Promise<Partial<S>> {

  const response = await invokeRoleModel("contract_draft", [

    {

      role: "system",

      content: `You are a technical lead drafting a task contract as a JSON object.



You MUST return ONLY a single valid JSON object with EXACTLY this shape (no extra fields, no different field names):



{

  "id": "${state.taskId}",

  "title": "<concise task title>",

  "goal": "<one paragraph goal statement>",

  "status": "AWAITING_APPROVAL",

  "owner": {

    "product": "<product owner name or placeholder>",

    "engineering": "<engineering owner name or placeholder>"

  },

  "scope": {

    "in": ["<item>", ...],

    "out": ["<item>", ...]

  },

  "dependencies": ["<task-id or description>", ...],

  "constraints": ["<constraint>", ...],

  "acceptance_criteria": [

    { "id": "AC-1", "requirement": "<requirement>", "verification": ["<method>", ...] },

    ...

  ],

  "risks": [

    { "risk": "<risk description>", "mitigation": "<mitigation strategy>" },

    ...

  ],

  "rollback": ["<rollback step>", ...],

  "approvals_required": ["Product", "Engineering"]

}



Rules:

- "id" must be exactly "${state.taskId}" (do not change it)

- "owner.product" and "owner.engineering" are plain strings

- "rollback" is an array of strings, not an object

- "approvals_required" is an array of plain strings like "Product" or "Engineering"

- "risks" elements have only "risk" and "mitigation" string fields

${CONTRACT_DRAFT_VERIFICATION_RULES}

- scope.out MUST include "tasks/${state.taskId}/contract.yaml" and ".taskgraph*"

- scope.in SHOULD include "tasks/${state.taskId}/evidence/" when evidence YAML files are expected

- Return only the JSON object, no markdown fences, no commentary`,

    },

    {

      role: "user",

      content: `Goal: ${state.goal}



Context:

${state.context}



Plan A:

${state.planA}



Plan B:

${state.planB}



Planner A review of Plan B:

${state.planAReview}



Planner B review of Plan A:

${state.planBReview}



Consensus:

${state.consensus}`,

    },

  ], { temperature: 0.1, responseFormat: "json_object" });



  try {

    const json = JSON.parse(response);

    const parsed = TaskContractSchema.safeParse(json);

    if (!parsed.success) {

      const errMsg = `Draft contract failed validation: ${parsed.error.issues

        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)

        .join("; ")}`;

      console.error(`[Planning Cell] ${errMsg}`);

      console.error(`[Planning Cell] Raw model JSON:\n${JSON.stringify(json, null, 2)}`);

      return { error: errMsg };

    }

    await recordArtifact({

      taskId: state.taskId,

      artifactType: "draft_contract",

      content: parsed.data,

    });

    await transitionTaskStatus({

      taskId: state.taskId,

      to: "AWAITING_APPROVAL",

      actor: "planning-cell",

      payload: { agent_run_id: state.agentRunId },

    });

    return { draftContract: parsed.data };

  } catch (err) {

    return { error: `Failed to parse contract JSON from model response: ${(err as Error).message}` };

  }

}



async function reviseDraftContract(

  state: S,

  contract: TaskContract,

  errors: string[],

): Promise<TaskContract | null> {

  const response = await invokeRoleModel("contract_revision", [

    {

      role: "system",

      content: `You are a technical lead revising a task contract JSON object.

Fix ONLY the executability issues listed. Keep the same task id and overall scope.

${CONTRACT_DRAFT_VERIFICATION_RULES}

Return ONLY the revised JSON object, no markdown fences.`,

    },

    {

      role: "user",

      content: `Executability errors to fix:

${errors.map((e) => `- ${e}`).join("\n")}



Current contract:

${JSON.stringify(contract, null, 2)}



Goal: ${state.goal}



Repo context:

${compactContext(state)}`,

    },

  ], { temperature: 0.1, responseFormat: "json_object" });



  try {

    const json = JSON.parse(response);

    const parsed = TaskContractSchema.safeParse(json);

    if (!parsed.success) return null;

    await recordArtifact({

      taskId: state.taskId,

      artifactType: "draft_contract_revised",

      content: parsed.data,

    });

    return parsed.data;

  } catch {

    return null;

  }

}



async function finalizeAutoApproval(state: S, contract: TaskContract): Promise<Partial<S>> {

  const packet = (await getLatestContextPacket(state.taskId)) ?? {};

  const execCtx = executabilityContextFromPacket(packet);

  const executability = validateContractExecutability(contract, execCtx);



  await enrichExecutionContextPacket(state.taskId, contract, packet, executability);



  await recordArtifact({

    taskId: state.taskId,

    artifactType: "human_notification",

    content: {

      type: "contract_auto_approved",

      task_id: state.taskId,

      contract_title: contract.title,

      draft_contract: contract,

      message: "Draft contract auto-approved by planning cell after multi-agent review and executability validation.",

      agent_run_id: state.agentRunId,

      notified_at: new Date().toISOString(),

    },

  });



  await publishContractVersion(state.taskId, contract);



  await recordArtifact({

    taskId: state.taskId,

    artifactType: "approved_contract",

    content: contract,

  });



  for (const role of contract.approvals_required ?? []) {

    await recordApproval({

      taskId: state.taskId,

      approver: "planning-cell-auto-approver",

      role,

      notes: "Auto-approved after multi-agent review and executability validation.",

    });

  }



  await transitionTaskStatus({

    taskId: state.taskId,

    to: "READY",

    actor: "planning-cell",

    payload: { agent_run_id: state.agentRunId, auto_approved: true },

    readiness: {

      contractValid: true,

      dependenciesComplete: await dependenciesComplete(state.taskId),

      approvalsComplete: true,

      contextPacketAvailable: true,

    },

  });



  console.log(`[Planning Cell] Contract auto-approved for ${state.taskId}: ${contract.title}`);

  return { draftContract: contract };

}



// Auto-approves when the contract passes executability validation.

async function autoApproveContract(state: S): Promise<Partial<S>> {

  if (!state.draftContract) return { error: "Cannot auto-approve without a draft contract" };



  let contract = state.draftContract as TaskContract;

  const packet = (await getLatestContextPacket(state.taskId)) ?? {};

  const execCtx = executabilityContextFromPacket(packet);



  let executability = validateContractExecutability(contract, execCtx);



  if (!executability.ok) {

    console.warn(

      `[Planning Cell] Contract executability failed for ${state.taskId}: ${executability.errors.join("; ")}`,

    );

    const revised = await reviseDraftContract(state, contract, executability.errors);

    if (revised) {

      contract = revised;

      executability = validateContractExecutability(contract, execCtx);

      await recordArtifact({

        taskId: state.taskId,

        artifactType: "draft_contract",

        content: contract,

      });

    }

  }



  if (!executability.ok) {

    await recordArtifact({

      taskId: state.taskId,

      artifactType: "contract_validation_failed",

      content: {

        errors: executability.errors,

        draft_contract: contract,

        agent_run_id: state.agentRunId,

      },

    });



    await recordArtifact({

      taskId: state.taskId,

      artifactType: "human_notification",

      content: {

        type: "contract_validation_failed",

        task_id: state.taskId,

        contract_title: contract.title,

        errors: executability.errors,

        message: "Draft contract failed executability validation. Human review required before READY.",

        agent_run_id: state.agentRunId,

        notified_at: new Date().toISOString(),

      },

    });



    console.log(

      `[Planning Cell] ${state.taskId} remains AWAITING_APPROVAL — executability validation failed`,

    );

    return {

      draftContract: contract,

      error: `Contract executability validation failed: ${executability.errors.join("; ")}`,

    };

  }



  return finalizeAutoApproval(state, contract);

}



function afterDraft(state: S): "stop" | "approve" {

  return state.stopAfterDraft ? "stop" : "approve";

}



// ---- Graph ----



const graph = new StateGraph(PlanningState)

  .addNode("producePlanA",           producePlanA)

  .addNode("producePlanB",           producePlanB)

  .addNode("reviewPlanBAsA",         reviewPlanBAsA)

  .addNode("reviewPlanAAsB",         reviewPlanAAsB)

  .addNode("synthesizeConsensus",    synthesizeConsensus)

  .addNode("generateDraftContract",  generateDraftContract)

  .addNode("autoApproveContract",    autoApproveContract)

  .addEdge("__start__",              "producePlanA")

  .addEdge("__start__",              "producePlanB")        // parallel with producePlanA

  .addEdge("producePlanA",           "reviewPlanBAsA")

  .addEdge("producePlanB",           "reviewPlanBAsA")

  .addEdge("producePlanA",           "reviewPlanAAsB")

  .addEdge("producePlanB",           "reviewPlanAAsB")

  .addEdge("reviewPlanBAsA",         "synthesizeConsensus")

  .addEdge("reviewPlanAAsB",         "synthesizeConsensus")

  .addEdge("synthesizeConsensus",    "generateDraftContract")

  .addConditionalEdges("generateDraftContract", afterDraft, {

    stop:    "__end__",

    approve: "autoApproveContract",

  })

  .addEdge("autoApproveContract",    "__end__");



// ---- Checkpointer + export ----



// Lazily initialised once per process. Falls back to MemorySaver if DATABASE_URL

// is absent or TASKGRAPH_DISABLE_POSTGRES_CHECKPOINT=true, so smoke tests can

// run without a direct Postgres connection.

let _workflow: ReturnType<typeof graph.compile> | null = null;



export async function getPlanningWorkflow(): Promise<ReturnType<typeof graph.compile>> {

  if (_workflow) return _workflow;



  const checkpointerDisabled = process.env.TASKGRAPH_DISABLE_POSTGRES_CHECKPOINT === "true";

  const url = checkpointerDisabled ? undefined : process.env.DATABASE_URL;

  let checkpointer: BaseCheckpointSaver;



  if (url) {

    try {

      const pg = PostgresSaver.fromConnString(url);

      await pg.setup();

      checkpointer = pg;

      console.log("[Planning Cell] Using PostgresSaver checkpointer");

    } catch (err) {

      console.warn(

        "[Planning Cell] PostgresSaver setup failed — falling back to MemorySaver:",

        err instanceof Error ? err.message : err,

      );

      checkpointer = new MemorySaver();

    }

  } else {

    console.warn(

      checkpointerDisabled

        ? "[Planning Cell] TASKGRAPH_DISABLE_POSTGRES_CHECKPOINT=true - using MemorySaver"

        : "[Planning Cell] DATABASE_URL not set - using MemorySaver (not durable across restarts)"

    );

    checkpointer = new MemorySaver();

  }



  _workflow = graph.compile({ checkpointer });

  return _workflow;

}


