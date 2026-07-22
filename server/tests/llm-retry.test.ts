import assert from 'node:assert/strict';
import { runWithRetry } from '../ai/llm-client';

async function testTimeoutAbortsProviderRequest(): Promise<void> {
  let aborted = false;
  await assert.rejects(
    runWithRetry(
      (signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('provider aborted'));
        });
      }),
      { maxRetries: 1, timeoutMs: 10 },
    ),
    /LLM request timed out/,
  );
  assert.equal(aborted, true);
}

async function testRetryPredicateStopsPartialStreamReplay(): Promise<void> {
  let attempts = 0;
  let emittedToken = false;
  await assert.rejects(
    runWithRetry(
      async () => {
        attempts += 1;
        emittedToken = true;
        throw new Error('stream interrupted');
      },
      {
        maxRetries: 3,
        timeoutMs: 100,
        shouldRetry: () => !emittedToken,
      },
    ),
    /stream interrupted/,
  );
  assert.equal(attempts, 1);
}

Promise.all([
  testTimeoutAbortsProviderRequest(),
  testRetryPredicateStopsPartialStreamReplay(),
]).then(
  () => console.log('LLM retry tests passed'),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
