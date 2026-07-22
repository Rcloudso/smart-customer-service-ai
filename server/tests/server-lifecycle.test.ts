import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve test port');
  await new Promise<void>((resolve, reject) => (
    server.close((error) => error ? reject(error) : resolve())
  ));
  return address.port;
}

async function waitUntilReady(url: string): Promise<Response> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('Server did not become ready');
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-lifecycle-'));
  const port = await reservePort();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        DB_PATH: path.join(tempDir, 'lifecycle.db'),
        JWT_SECRET: 'test-secret-123',
        LLM_API_KEY: '',
        OPENAI_API_KEY: '',
        EMBED_PROVIDER: 'other',
        EMBED_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  let forcedChild: ReturnType<typeof spawn> | null = null;
  let hangingSocket: net.Socket | null = null;
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    const ready = await waitUntilReady(`http://127.0.0.1:${port}/api/ready`);
    assert.deepEqual(await ready.json(), {
      code: 0,
      data: { status: 'ready' },
      message: 'ok',
    });

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { data: { status: string } }).data.status, 'ok');

    child.kill('SIGTERM');
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not stop after SIGTERM')), 5_000);
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    assert.deepEqual(exit, { code: 0, signal: null });

    const forcedPort = await reservePort();
    forcedChild = spawn(
      process.execPath,
      ['--import', 'tsx', 'server/index.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(forcedPort),
          DB_PATH: path.join(tempDir, 'forced-lifecycle.db'),
          JWT_SECRET: 'test-secret-123',
          LLM_API_KEY: '',
          OPENAI_API_KEY: '',
          EMBED_PROVIDER: 'other',
          EMBED_API_KEY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    forcedChild.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await waitUntilReady(`http://127.0.0.1:${forcedPort}/api/ready`);

    hangingSocket = net.createConnection({ host: '127.0.0.1', port: forcedPort });
    await new Promise<void>((resolve, reject) => {
      hangingSocket?.once('connect', resolve);
      hangingSocket?.once('error', reject);
    });
    hangingSocket.write(
      'POST /api/chat HTTP/1.1\r\n'
      + `Host: 127.0.0.1:${forcedPort}\r\n`
      + 'Content-Type: application/json\r\n'
      + 'Content-Length: 100000\r\n'
      + '\r\n'
      + '{"message":"incomplete',
    );

    const forcedStartedAt = Date.now();
    forcedChild.kill('SIGTERM');
    const forcedExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Forced shutdown did not complete')), 15_000);
      forcedChild?.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    assert.deepEqual(forcedExit, { code: 1, signal: null });
    assert.ok(Date.now() - forcedStartedAt >= 9_000, 'active request should exercise the bounded timeout path');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (
      forcedChild
      && forcedChild.exitCode === null
      && forcedChild.signalCode === null
    ) {
      forcedChild.kill('SIGKILL');
    }
    hangingSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(
  () => console.log('server lifecycle tests passed'),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
