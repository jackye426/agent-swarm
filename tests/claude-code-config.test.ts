import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeCodePipeShellCommand,
  claudeCodeDefaultFlags,
  claudeCodeModel,
} from "../src/cells/engineering/claude-code-config.js";

test("claudeCodeModel returns trimmed CLAUDE_CODE_MODEL", () => {
  assert.equal(
    claudeCodeModel({ CLAUDE_CODE_MODEL: "  claude-sonnet-4-20250514  " }),
    "claude-sonnet-4-20250514",
  );
});

test("claudeCodeModel returns undefined when unset or blank", () => {
  assert.equal(claudeCodeModel({}), undefined);
  assert.equal(claudeCodeModel({ CLAUDE_CODE_MODEL: "  " }), undefined);
});

test("claudeCodeDefaultFlags includes --model when CLAUDE_CODE_MODEL is set", () => {
  assert.deepEqual(claudeCodeDefaultFlags({ CLAUDE_CODE_MODEL: "claude-opus-4-20250514" }), [
    "--print",
    "--dangerously-skip-permissions",
    "--model",
    "claude-opus-4-20250514",
  ]);
});

test("claudeCodeDefaultFlags omits --model when unset", () => {
  assert.deepEqual(claudeCodeDefaultFlags({}), ["--print", "--dangerously-skip-permissions"]);
});

test("buildClaudeCodePipeShellCommand embeds model flag on Unix", () => {
  const cmd = buildClaudeCodePipeShellCommand(
    "claude",
    "/tmp/plan.txt",
    { CLAUDE_CODE_MODEL: "claude-sonnet-4-20250514" },
    "linux",
  );
  assert.match(cmd, /claude-sonnet-4-20250514/);
  assert.match(cmd, /--model/);
  assert.match(cmd, /\/tmp\/plan\.txt/);
});

test("buildClaudeCodePipeShellCommand embeds model flag on Windows", () => {
  const cmd = buildClaudeCodePipeShellCommand(
    "claude",
    "C:\\tmp\\plan.txt",
    { CLAUDE_CODE_MODEL: "claude-sonnet-4-20250514" },
    "win32",
  );
  assert.match(cmd, /Get-Content/);
  assert.match(cmd, /claude-sonnet-4-20250514/);
});
