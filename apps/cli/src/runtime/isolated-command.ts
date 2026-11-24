import { OsSandboxProvider } from '@forgex/sandbox';
import type { ProcessResult, ProcessSpec } from '@forgex/tools';
import type { PolicySettings } from '@forgex/shared';

/** Create a fail-closed OS sandbox runner scoped to one workspace. */
export function createIsolatedCommandExecutor(
  workspaceRoot: string,
  protectedPaths: PolicySettings['protectedPaths'] = [],
): (spec: ProcessSpec, signal?: AbortSignal) => Promise<ProcessResult> {
  const sandbox = new OsSandboxProvider({ workspaceRoot, allowedCwdRoots: [workspaceRoot], protectedPaths });
  return async (spec, signal) => {
    const env = Object.fromEntries(Object.entries(spec.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const result = await sandbox.execUntrusted({
      program: spec.program,
      args: [...spec.args],
      cwd: spec.cwd ?? workspaceRoot,
      env,
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
    }, {
      workDir: workspaceRoot,
      allowNetwork: false,
      signal,
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
    });
    return {
      code: result.code,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
      aborted: signal?.aborted ?? false,
      durationMs: result.durationMs,
    };
  };
}
