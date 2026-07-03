import test from "node:test";
import assert from "node:assert/strict";
import {
  createRetryFetch,
  isRetryableTransportError,
  sleep,
} from "../src/db/retry-fetch.js";

test("isRetryableTransportError matches fetch failed and network errors", () => {
  assert.equal(isRetryableTransportError(new TypeError("fetch failed")), true);
  assert.equal(isRetryableTransportError(new Error("network timeout")), true);
  assert.equal(isRetryableTransportError(new Error("ECONNRESET")), true);
  assert.equal(isRetryableTransportError(new Error("permission denied")), false);
});

test("createRetryFetch succeeds after transient failures", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    if (calls < 3) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const delays: number[] = [];
  const retryFetch = createRetryFetch(fakeFetch, {
    maxAttempts: 5,
    baseDelayMs: 1,
    onRetry: ({ delayMs }) => delays.push(delayMs),
  });

  const response = await retryFetch("https://example.test/rest/v1/tasks");
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
});

test("createRetryFetch does not retry non-transport errors", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    throw new Error("invalid API key");
  };

  const retryFetch = createRetryFetch(fakeFetch, { maxAttempts: 5, baseDelayMs: 1 });

  await assert.rejects(
    () => retryFetch("https://example.test/rest/v1/tasks"),
    /invalid API key/,
  );
  assert.equal(calls, 1);
});

test("createRetryFetch returns HTTP error responses without retrying", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response("Unauthorized", { status: 401 });
  };

  const retryFetch = createRetryFetch(fakeFetch, { maxAttempts: 5, baseDelayMs: 1 });
  const response = await retryFetch("https://example.test/rest/v1/tasks");
  assert.equal(response.status, 401);
  assert.equal(calls, 1);
});

test("createRetryFetch throws after maxAttempts exhausted", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    throw new TypeError("fetch failed");
  };

  const retryFetch = createRetryFetch(fakeFetch, { maxAttempts: 3, baseDelayMs: 1 });

  await assert.rejects(
    () => retryFetch("https://example.test/rest/v1/tasks"),
    /fetch failed/,
  );
  assert.equal(calls, 3);
});

test("sleep resolves after delay", async () => {
  const start = Date.now();
  await sleep(20);
  assert.ok(Date.now() - start >= 15);
});
