import "dotenv/config";
import { db } from "../db/client.js";
import { enqueue } from "../db/queue.js";

export interface CreateTaskInput {
  goal: string;
  context: string;
  source: string; // human-readable origin, e.g. "telegram", "github:owner/repo#42"
}

export interface CreatedTask {
  taskId: string;
  goal: string;
}

// Generates the next T-NNN ID by reading the current max from the tasks table.
async function nextTaskId(): Promise<string> {
  const { data, error } = await db
    .from("tasks")
    .select("id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to generate task ID: ${error.message}`);

  const lastId = (data as { id: string } | null)?.id ?? "T-000";
  const num = parseInt(lastId.replace("T-", ""), 10);
  return `T-${String(num + 1).padStart(3, "0")}`;
}

// Creates a task at DRAFT and enqueues a planning job for it.
// Returns immediately — the planning cell picks it up asynchronously.
export async function createAndEnqueueTask(input: CreateTaskInput): Promise<CreatedTask> {
  const taskId = await nextTaskId();

  const { error: upsertError } = await db.from("tasks").upsert({
    id: taskId,
    title: input.goal.slice(0, 120), // truncate to fit the title column
    status: "DRAFT",
    cell: "planning",
    contract_version: 0,
  });

  if (upsertError) throw new Error(`Failed to create task ${taskId}: ${upsertError.message}`);

  await db.from("task_events").insert({
    task_id: taskId,
    event_type: "task_created",
    actor: input.source,
    payload: { goal: input.goal, source: input.source },
  });

  await enqueue({
    job_type: "task.plan.requested",
    task_id: taskId,
    payload: {
      task_id: taskId,
      goal: input.goal,
      context: input.context,
      stop_after_draft: false,
    },
  });

  console.log(`[Intake] Created ${taskId} from ${input.source}: ${input.goal.slice(0, 60)}`);
  return { taskId, goal: input.goal };
}
