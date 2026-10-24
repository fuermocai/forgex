import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@forgex/shared': r('./packages/shared/src/index.ts'),
      '@forgex/models': r('./packages/models/src/index.ts'),
      '@forgex/security': r('./packages/security/src/index.ts'),
      '@forgex/devops': r('./packages/devops/src/index.ts'),
      '@forgex/tools': r('./packages/tools/src/index.ts'),
      '@forgex/core': r('./packages/core/src/index.ts'),
      '@forgex/workflows': r('./packages/workflows/src/index.ts'),
      '@forgex/sandbox': r('./packages/sandbox/src/index.ts'),
      '@forgex/approval': r('./packages/approval/src/index.ts'),
      '@forgex/integrations': r('./packages/integrations/src/index.ts'),
      '@forgex/observability': r('./packages/observability/src/index.ts'),
      '@forgex/recovery': r('./packages/recovery/src/index.ts'),
      '@forgex/requirement-engine': r('./packages/requirement-engine/src/index.ts'),
      '@forgex/autonomous': r('./packages/autonomous/src/index.ts'),
      '@forgex/quality-gate': r('./packages/quality-gate/src/index.ts'),
      '@forgex/orchestrator': r('./packages/orchestrator/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
});
