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
  | "verification";

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
};

export function modelForRole(role: ModelRole): string {
  return process.env[roleEnv[role]] || defaultModels[role];
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
