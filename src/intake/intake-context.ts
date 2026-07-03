/** Default user_context for intake-created tasks (Telegram / GitHub). */
export function formatIntakeUserContext(source: "telegram" | "github"): string {
  const lines = [
    source === "telegram"
      ? "Task created via Telegram bot."
      : "Task created via GitHub issue intake.",
    "Use only npm test for verification unless the goal specifies otherwise.",
    "Only product files in commits; do not modify package-lock.json or .gitignore unless required.",
  ];
  return lines.join("\n");
}
