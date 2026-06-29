import type { QueueJobType } from "./types.js";

export function physicalQueueName(queueName: QueueJobType): string {
  return queueName.replaceAll(".", "_");
}
