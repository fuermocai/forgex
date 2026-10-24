/**
 * ProjectOrchestrator：跨模块协调器（v0.5.0 Phase 4）。
 *
 * 职责：
 *   - 解析项目包依赖（从 package.json workspaces）；
 *   - 拓扑排序确定执行顺序；
 *   - 协调多个 AutonomousRunner 按顺序执行（Phase 2）；
 *   - 支持并行独立模块（可选）。
 */
import { DependencyGraph } from './dependency-graph.js';

export interface PackageInfo {
  name: string;
  dir: string;
  dependencies: string[];
}

export interface OrchestratorPlan {
  executionOrder: string[];
  groups: string[][]; // 可并行的组（同层拓扑）
}

export class ProjectOrchestrator {
  private readonly depGraph = new DependencyGraph();
  private readonly packages = new Map<string, PackageInfo>();

  register(pkg: PackageInfo): void {
    this.packages.set(pkg.name, pkg);
    this.depGraph.addNode(pkg.name);
    for (const dep of pkg.dependencies) {
      this.depGraph.addNode(dep);
      this.depGraph.addEdge(pkg.name, dep);
    }
  }

  /**
   * 生成执行计划：拓扑排序 + 分层（同层可并行）。
   */
  plan(): OrchestratorPlan {
    const order = this.depGraph.topologicalOrder();

    // 分层：每个节点的深度 = max(上游深度) + 1
    const depth = new Map<string, number>();
    for (const n of order) {
      const upstream = this.depGraph.directUpstream(n);
      const maxUpstreamDepth = upstream.length === 0
        ? -1
        : Math.max(...upstream.map((u) => depth.get(u) ?? 0));
      depth.set(n, maxUpstreamDepth + 1);
    }

    const groups = new Map<number, string[]>();
    for (const [n, d] of depth) {
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d)!.push(n);
    }

    return {
      executionOrder: order,
      groups: [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g),
    };
  }

  getGraph(): DependencyGraph {
    return this.depGraph;
  }
}
