import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { createAndEnqueueTask } from "../task-creator.js";
import { resolveRepoForIntake } from "../repo-resolver.js";
import { sendNotification } from "../telegram.js";

const router: Router = createRouter();

function verifySignature(secret: string, body: Buffer, signature: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

router.post("/webhook/github", async (req: Request, res: Response) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: "GITHUB_WEBHOOK_SECRET not configured" });
    return;
  }

  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signature || !verifySignature(secret, req.body as Buffer, signature)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const event = req.headers["x-github-event"] as string;
  const payload = JSON.parse((req.body as Buffer).toString("utf8")) as Record<string, unknown>;

  if (event !== "issues" || payload.action !== "labeled") {
    res.status(200).json({ ignored: true });
    return;
  }

  const label = (payload.label as { name?: string } | undefined)?.name ?? "";
  if (label.toLowerCase() !== "taskgraph") {
    res.status(200).json({ ignored: true });
    return;
  }

  const issue = payload.issue as {
    title: string;
    body: string | null;
    html_url: string;
    number: number;
  };
  const repoFullName = (payload.repository as { full_name: string }).full_name;

  const goal = issue.title;
  const context = [
    `GitHub issue: ${issue.html_url}`,
    `Repository: ${repoFullName}`,
    issue.body ? `\nIssue description:\n${issue.body}` : "",
  ].join("\n");

  try {
    const repo = await resolveRepoForIntake({ githubRepoFullName: repoFullName });
    const { taskId } = await createAndEnqueueTask({
      goal,
      context,
      sourceLabel: `github:${repoFullName}#${issue.number}`,
      sourceKind: "github",
      repo,
      sourceContext: {
        github_issue_url: issue.html_url,
        github_issue_number: issue.number,
      },
    });

    await sendNotification(
      `🔗 *${taskId}* created from GitHub issue\n` +
        `*${repoFullName}#${issue.number}:* ${goal}\n` +
        `Planning started.`,
    );

    res.status(200).json({ task_id: taskId });
  } catch (err) {
    console.error("[GitHub Webhook] Failed to create task:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export { router as githubRouter };
