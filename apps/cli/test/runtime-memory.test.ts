import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@forgex/shared';
import { loadConfig } from '../src/config/load-config.js';
import { createRuntime } from '../src/runtime/create-runtime.js';

const silent = createLogger({ level: 'silent' });
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runtime project memory', () => {
  it('disabled memory performs zero file reads or writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-memory-disabled-'));
    directories.push(dir);
    const memoryPath = join(dir, 'must-not-be-created.jsonl');
    const configPath = join(dir, 'forgex.config.json');
    await writeFile(configPath, JSON.stringify({ memory: { enabled: false, path: 'must-not-be-created.jsonl' } }), 'utf8');
    const loaded = loadConfig({ cwd: dir, env: {}, skipGlobal: true, skipCredentials: true, logger: silent });

    const runtime = createRuntime({ cwd: dir, loaded, logger: silent });
    try {
      expect(runtime.memory).toBeUndefined();
      expect(existsSync(memoryPath)).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it('does not create an empty memory file before the first explicit write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgex-memory-enabled-'));
    directories.push(dir);
    const memoryPath = join(dir, 'project-memory.jsonl');
    const configPath = join(dir, 'forgex.config.json');
    await writeFile(configPath, JSON.stringify({ memory: { enabled: true, path: 'project-memory.jsonl' } }), 'utf8');
    const loaded = loadConfig({ cwd: dir, env: {}, skipGlobal: true, skipCredentials: true, logger: silent });

    const runtime = createRuntime({ cwd: dir, loaded, logger: silent });
    try {
      expect(runtime.memory).toBeDefined();
      expect(existsSync(memoryPath)).toBe(false);
      runtime.memory!.rememberUserFact({
        scope: 'project', key: 'test.fact', content: 'persist after explicit write',
        workspace: dir, evidence_refs: ['user:test'],
      });
      expect(existsSync(memoryPath)).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
