import "dotenv/config";

export type ModelRole =
  | "planning_a"
  | "planning_b"
  | "planning_a_review"
  | "planning_b_review"
  | "planning_consensus"
  | "contract_draft"
  | "contract_revision"
  | "engineering_plan"
  | "verification"
  | "intake_conversation";

export interface RoleMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const roleEnv: Record<ModelRole, string> = {
  planning_a: "MODEL_PLANNING_A",
  planning_b: "MODEL_PLANNING_B",
  planning_a_review: "MODEL_PLANNING_A_REVIEW",
  planning_b_review: "MODEL_PLANNING_B_REVIEW",
  planning_consensus: "MODEL_PLANNING_CONSENSUS",
  contract_draft: "MODEL_CONTRACT_DRAFT",
  contract_revision: "MODEL_CONTRACT_REVISION",
  engineering_plan: "MODEL_ENGINEERING_PLAN",
  verification: "MODEL_VERIFICATION",
  intake_conversation: "MODEL_INTAKE_CONVERSATION",
};

const defaultModels: Record<ModelRole, string> = {
  planning_a: "anthropic/claude-opus-4.8",
  planning_b: "openai/gpt-5.5",
  planning_a_review: "anthropic/claude-opus-4.8",
  planning_b_review: "openai/gpt-5.5",
  planning_consensus: "anthropic/claude-opus-4.8",
  contract_draft: "anthropic/claude-opus-4.8",
  contract_revision: "anthropic/claude-opus-4.8",
  engineering_plan: "anthropic/claude-opus-4.8",
  verification: "openai/gpt-5.5",
  intake_conversation: "anthropic/claude-opus-4.8",
};

const roleMaxTokensEnv: Record<ModelRole, string> = {
  planning_a: "MODEL_PLANNING_A_MAX_TOKENS",
  planning_b: "MODEL_PLANNING_B_MAX_TOKENS",
  planning_a_review: "MODEL_PLANNING_A_REVIEW_MAX_TOKENS",
  planning_b_review: "MODEL_PLANNING_B_REVIEW_MAX_TOKENS",
  planning_consensus: "MODEL_PLANNING_CONSENSUS_MAX_TOKENS",
  contract_draft: "MODEL_CONTRACT_DRAFT_MAX_TOKENS",
  contract_revision: "MODEL_CONTRACT_REVISION_MAX_TOKENS",
  engineering_plan: "MODEL_ENGINEERING_PLAN_MAX_TOKENS",
  verification: "MODEL_VERIFICATION_MAX_TOKENS",
  intake_conversation: "MODEL_INTAKE_CONVERSATION_MAX_TOKENS",
};

export function modelForRole(role: ModelRole): string {
  return process.env[roleEnv[role]] || defaultModels[role];
}

export function maxTokensForRole(role: ModelRole): number | undefined {
  const configured = process.env[roleMaxTokensEnv[role]] ?? process.env.MODEL_MAX_TOKENS;
  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (role === "verification") return 8192;
  return undefined;
}

export async function invokeRoleModel(
  role: ModelRole,
  messages: RoleMessage[],
  options: { temperature?: number; responseFormat?: "json_object" } = {}
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY must be set to invoke role models");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "TaskGraph OS",
    },
    body: JSON.stringify({
      model: modelForRole(role),
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: maxTokensForRole(role),
      response_format: options.responseFormat ? { type: options.responseFormat } : undefined,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter ${role} call failed (${response.status}): ${body}`);
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  let content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenRouter ${role} call returned no content`);
  if (options.responseFormat === "json_object") {
    content = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return content;
}
