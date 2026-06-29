import { db } from "./client.js";
import type { QueueJob, QueueJobType } from "../core/types.js";
import { physicalQueueName } from "../core/queue-names.js";

// Supabase Queues are backed by pgmq.
// Messages are sent via the pgmq.send() function.

export async function enqueue(job: QueueJob): Promise<void> {
  const { error } = await db.rpc("pgmq_send", {
    queue_name: physicalQueueName(job.job_type),
    message: { task_id: job.task_id, ...job.payload },
  });
  if (error) throw new Error(`Failed to enqueue ${job.job_type}: ${error.message}`);
}

export async function dequeue(queueName: QueueJobType, visibilityTimeout = 30): Promise<QueueMessage | null> {
  const { data, error } = await db.rpc("pgmq_read", {
    queue_name: physicalQueueName(queueName),
    vt: visibilityTimeout,
    qty: 1,
  });
  if (error) throw new Error(`Failed to dequeue from ${queueName}: ${error.message}`);
  return data?.[0] ?? null;
}

export async function ack(queueName: QueueJobType, msgId: number): Promise<void> {
  const { error } = await db.rpc("pgmq_delete", {
    queue_name: physicalQueueName(queueName),
    msg_id: msgId,
  });
  if (error) throw new Error(`Failed to ack message ${msgId}: ${error.message}`);
}

export interface QueueMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: Record<string, unknown>;
}
