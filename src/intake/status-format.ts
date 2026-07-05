export interface TaskStatusView {
  id: string;
  title: string;
  status: string;
  repo_full_name: string | null;
  updated_at: string;
}

export function formatTaskStatusMessage(task: TaskStatusView): string {
  const repoLine = task.repo_full_name ? `\nRepo: ${task.repo_full_name}` : "";
  return `${task.id} - ${task.status}\n${task.title}${repoLine}\nUpdated: ${new Date(
    task.updated_at,
  ).toLocaleString()}`;
}
