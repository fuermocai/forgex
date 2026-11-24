import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ProjectSelection } from '../shared/desktop-api.js';

const MAX_RECENT_PROJECTS = 10;

export class RecentProjectStore {
  constructor(private readonly filePath: string) {}

  list(): ProjectSelection[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const value: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(value)) return [];
      return value.filter(isProjectSelection).slice(0, MAX_RECENT_PROJECTS);
    } catch {
      return [];
    }
  }

  remember(project: ProjectSelection): void {
    const list = [project, ...this.list().filter((item) => item.path !== project.path)].slice(0, MAX_RECENT_PROJECTS);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(list, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Windows permissions are managed by the user profile ACL.
    }
  }
}

function isProjectSelection(value: unknown): value is ProjectSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.path === 'string' && typeof item.name === 'string';
}
