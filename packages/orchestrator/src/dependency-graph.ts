/**
 * DependencyGraph：项目依赖图（v0.5.0 Phase 4）。
 *
 * 职责：
 *   - 管理包/模块间依赖关系；
 *   - 拓扑排序 → 确定构建/测试顺序；
 *   - 循环依赖检测（关键安全约束：循环依赖可能导致构建死锁）；
 *   - 影响面分析（变更 A 模块会影响哪些下游）。
 */
import { ForgeError } from '@forgex/shared';

export interface DepEdge {
  from: string;
  to: string;
  type: 'runtime' | 'dev' | 'peer';
}

export class DependencyGraph {
  private readonly nodes = new Set<string>();
  private readonly edges: DepEdge[] = [];

  addNode(id: string): void {
    this.nodes.add(id);
  }

  addEdge(from: string, to: string, type: DepEdge['type'] = 'runtime'): void {
    this.nodes.add(from);
    this.nodes.add(to);
    this.edges.push({ from, to, type });
  }

  /** 拓扑排序（Kahn's algorithm），有环时抛错。
   *
   * edge 语义: addEdge(A, B) = A 依赖 B → B 必须排在 A 之前。
   * 反向图构建：B → A 的边表示 B 是 A 的前置依赖。
   */
  topologicalOrder(): string[] {
    const indegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const n of this.nodes) {
      indegree.set(n, 0);
      adj.set(n, []);
    }
    // 反向建图：原 edge (from=A, to=B, "A depends on B") → 在排序列表中 B 在 A 之前
    // 所以反向 adjacency 是 B → A（B 完成后 A 才能开始）
    for (const e of this.edges) {
      // 原: from depends on to → to is prerequisite of from
      // 反向边: to → from
      adj.get(e.to)!.push(e.from);
      indegree.set(e.from, (indegree.get(e.from) ?? 0) + 1);
    }

    const queue: string[] = [];
    for (const [n, d] of indegree) if (d === 0) queue.push(n);

    const order: string[] = [];
    while (queue.length > 0) {
      const n = queue.shift()!;
      order.push(n);
      for (const m of adj.get(n) ?? []) {
        indegree.set(m, (indegree.get(m) ?? 0) - 1);
        if (indegree.get(m) === 0) queue.push(m);
      }
    }

    if (order.length !== this.nodes.size) {
      const cycleNodes = [...this.nodes].filter((n) => !order.includes(n));
      throw new ForgeError(
        'REQUIREMENT_AMBIGUITY_UNRESOLVED',
        `检测到循环依赖: ${cycleNodes.join(' → ')}`,
        { details: { cycleNodes } },
      );
    }

    return order;
  }

  /** 反向依赖 → 下游影响面 */
  downstream(dependsOn: string): string[] {
    const result = new Set<string>();
    const queue = [dependsOn];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const e of this.edges) {
        if (e.to === cur && !result.has(e.from)) {
          result.add(e.from);
          queue.push(e.from);
        }
      }
    }
    return [...result];
  }

  /** 直接上游（这个 node 依赖哪些） */
  directUpstream(node: string): string[] {
    return this.edges.filter((e) => e.from === node).map((e) => e.to);
  }

  nodesList(): string[] {
    return [...this.nodes];
  }
}
