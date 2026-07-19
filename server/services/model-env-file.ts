import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const ENV_ASSIGNMENT_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function serializeEnvValue(value: string): string {
  return JSON.stringify(value);
}

export function updateEnvFileAtomically(
  filePath: string,
  updates: Record<string, string>,
  removals: readonly string[] = [],
): void {
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original === '' ? [] : original.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  const removalSet = new Set(removals);
  const written = new Set<string>();
  const nextLines: string[] = [];

  for (const line of lines) {
    const key = line.match(ENV_ASSIGNMENT_PATTERN)?.[1];
    if (!key || (!(key in updates) && !removalSet.has(key))) {
      nextLines.push(line);
      continue;
    }

    if (removalSet.has(key) || written.has(key)) {
      continue;
    }

    nextLines.push(`${key}=${serializeEnvValue(updates[key])}`);
    written.add(key);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key) && !removalSet.has(key)) {
      nextLines.push(`${key}=${serializeEnvValue(value)}`);
    }
  }

  const nextContent = nextLines.length > 0 ? `${nextLines.join(newline)}${newline}` : '';
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    fs.writeFileSync(tempPath, nextContent, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw error;
  }
}
