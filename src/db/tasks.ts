import { db } from "./client.js";
import {
  assertComplete,
  assertReady,
  assertTransition,
  canTransition,
  type CompletionContext,
  type ReadinessContext,
} from "../core/state-machine.js";
import type { TaskStatus } from "../core/types.js";

export interface TransitionTaskOptions {
  taskId: string;
  to: TaskStatus;
  actor: string;
  payload?: Record<string, unknown>;
  readiness?: ReadinessContext;
  completion?: CompletionContext;
}

export async function transitionTaskStatus(options: TransitionTaskOptions): Promise<void> {
  const { data: task, error: fetchError } = await db
    .from("tasks")
    .select("status")
    .eq("id", options.taskId)
    .single();

  if (fetchError) {
    throw new Error(`Failed to load task ${options.taskId}: ${fetchError.message}`);
  }
  if (!task) {
    throw new Error(`Task ${options.taskId} not found`);
  }

  const from = task.status as TaskStatus;
  assertTransition(from, options.to);

  if (options.to === "READY") {
    if (!options.readiness) {
      throw new Error("Readiness context is required when transitioning to READY");
    }
    assertReady(options.readiness);
  }

  if (options.to === "COMPLETE") {
    if (!options.completion) {
      throw new Error("Completion context is required when transitioning to COMPLETE");
    }
    assertComplete(options.completion);
  }

  const { error: updateError } = await db
    .from("tasks")
    .update({ status: options.to })
    .eq("id", options.taskId);

  if (updateError) {
    throw new Error(`Failed to transition task ${options.taskId}: ${updateError.message}`);
  }

  const { error: eventError } = await db.from("task_events").insert({
    task_id: options.taskId,
    event_type: "status_changed",
    from_status: from,
    to_status: options.to,
    actor: options.actor,
    payload: options.payload ?? {},
  });

  if (eventError) {
    throw new Error(`Task ${options.taskId} transitioned but event write failed: ${eventError.message}`);
  }
}

/** Transition when legal; returns false without throwing if the edge is not allowed. */
export async function transitionTaskStatusIfLegal(options: TransitionTaskOptions): Promise<boolean> {
  const from = await getTaskStatus(options.taskId);
  if (!canTransition(from, options.to)) return false;
  await transitionTaskStatus(options);
  return true;
}

export async function getTaskStatus(taskId: string): Promise<TaskStatus> {
  const { data, error } = await db
    .from("tasks")
    .select("status")
    .eq("id", taskId)
    .single();

  if (error) throw new Error(`Failed to load task ${taskId}: ${error.message}`);
  return (data as { status: TaskStatus }).status;
}
