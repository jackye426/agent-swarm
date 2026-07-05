import test from "node:test";
import assert from "node:assert/strict";
import { chooseRemoteDefaultRef } from "../src/cells/engineering/workflow.js";

test("chooseRemoteDefaultRef prefers origin/main when origin/HEAD is absent", () => {
  assert.equal(chooseRemoteDefaultRef("origin/feature\norigin/main\n"), "origin/main");
});

test("chooseRemoteDefaultRef follows origin/HEAD arrow when listed", () => {
  assert.equal(chooseRemoteDefaultRef("origin/HEAD -> origin/trunk\norigin/trunk\n"), "origin/trunk");
});

test("chooseRemoteDefaultRef falls back to first origin branch", () => {
  assert.equal(chooseRemoteDefaultRef("upstream/main\norigin/release\n"), "origin/release");
});
