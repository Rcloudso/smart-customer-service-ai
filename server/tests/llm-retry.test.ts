import assert from 'node:assert/strict';
import { BoundedStreamBuffer, runWithRetry } from '../ai/llm-client';

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

function testStreamBufferUsesUtf8ByteLimit(): void {
  const buffer = new BoundedStreamBuffer(10);
  buffer.append('你好');
  buffer.append('a');
  assert.equal(buffer.value, '你好a');
  assert.throws(
    () => buffer.append('世界'),
    /stream exceeded 10 bytes/,
  );
}

Promise.all([
  testTimeoutAbortsProviderRequest(),
  testRetryPredicateStopsPartialStreamReplay(),
]).then(
  () => {
    testStreamBufferUsesUtf8ByteLimit();
    console.log('LLM retry tests passed');
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
