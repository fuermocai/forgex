/**
 * Kubernetes 只读诊断 Guard。
 *
 * 校验三层：
 *   1. connection 有效性（kubeconfigPath 或 apiServerUrl）
 *   2. action 必须在 K8sDiagAction 联合类型里（Zod discriminatedUnion）
 *   3. 命名空间白名单（如果配置了） + 参数范围校验
 *
 * 命名空间范围转换：
 *   single → 具体命名空间；all → "" 空字符串（k8s API 的 all-namespaces 用法）
 */
import { z } from 'zod';
import type { K8sConnection, K8sDiagAction, NamespaceScope } from './types.js';

/* ------------------------------------------------------------------ */
/* Zod Schema                                                           */
/* ------------------------------------------------------------------ */

const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const NamespaceScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), name: z.string().regex(NAMESPACE_RE, '命名空间名必须匹配 [a-z0-9]([a-z0-9-]*[a-z0-9])?') }),
  z.object({ kind: z.literal('all') }),
]);

const ActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('pods_list'),
    namespace: NamespaceScopeSchema,
    labelSelector: z.string().max(256).optional(),
    fieldSelector: z.string().max(256).optional(),
  }),
  z.object({ action: z.literal('pod_inspect'), namespace: z.string().regex(NAMESPACE_RE), podName: z.string().min(1).max(253) }),
  z.object({
    action: z.literal('pod_logs'),
    namespace: z.string().regex(NAMESPACE_RE),
    podName: z.string().min(1).max(253),
    containerName: z.string().min(1).max(253).optional(),
    tailLines: z.number().int().min(1).max(100000).default(2000),
    sinceSeconds: z.number().int().min(1).max(86_400).optional(),
  }),
  z.object({ action: z.literal('deployments_list'), namespace: NamespaceScopeSchema }),
  z.object({ action: z.literal('deployment_inspect'), namespace: z.string().regex(NAMESPACE_RE), deploymentName: z.string().min(1).max(253) }),
  z.object({ action: z.literal('services_list'), namespace: NamespaceScopeSchema }),
  z.object({ action: z.literal('ingresses_list'), namespace: NamespaceScopeSchema }),
  z.object({ action: z.literal('nodes_list') }),
  z.object({
    action: z.literal('events_list'),
    namespace: NamespaceScopeSchema,
    involvedObjectKind: z.string().max(64).optional(),
    involvedObjectName: z.string().max(253).optional(),
  }),
  z.object({ action: z.literal('configmaps_list'), namespace: NamespaceScopeSchema }),
  z.object({ action: z.literal('secrets_list'), namespace: NamespaceScopeSchema }),
  z.object({ action: z.literal('cluster_info') }),
]);

export interface K8sGuardInput {
  connection: K8sConnection;
  action: K8sDiagAction;
  /** 命名空间白名单（可选，空或 undefined 表示不限制） */
  allowedNamespaces?: readonly string[];
}

export interface GuardedK8sRequest {
  connection: K8sConnection;
  action: K8sDiagAction;
  /** HTTP method（全 GET） */
  method: 'GET';
  /** K8s API 路径（相对 apiserver） */
  path: string;
  /** 超时毫秒数 */
  timeoutMs: number;
}

/* ------------------------------------------------------------------ */
/* Guard 实现                                                           */
/* ------------------------------------------------------------------ */

export class K8sGuard {
  validate(input: K8sGuardInput): GuardedK8sRequest {
    this.validateConnection(input.connection);

    const action = ActionSchema.parse(input.action) as K8sDiagAction;

    // 命名空间白名单检查
    this.checkNamespaceAllowed(action, input.allowedNamespaces);

    // 构建 API path
    const path = this.buildPath(action);

    return {
      connection: input.connection,
      action,
      method: 'GET',
      path,
      timeoutMs: this.timeoutFor(action),
    };
  }

  private validateConnection(conn: K8sConnection): void {
    if ('kubeconfigPath' in conn && conn.kubeconfigPath) return;
    if ('apiServerUrl' in conn && conn.apiServerUrl) return;
    throw new Error('K8sGuard: connection 必须提供 kubeconfigPath 或 apiServerUrl 之一');
  }

  private checkNamespaceAllowed(action: K8sDiagAction, allowed?: readonly string[]): void {
    if (!allowed || allowed.length === 0) return;

    const ns = this.extractNamespace(action);
    if (ns === undefined || ns === '*' || ns === '') return; // all namespaces 放行

    if (!allowed.includes(ns)) {
      const allowedStr = allowed.join(', ');
      throw new Error(`K8sGuard: 命名空间 ${ns} 不在白名单内 (允许: ${allowedStr})`);
    }
  }

  /** 从 action 里提取具体命名空间（undefined 表示 all-namespaces 或不需要命名空间） */
  private extractNamespace(action: K8sDiagAction): string | undefined {
    switch (action.action) {
      case 'pod_inspect':
      case 'pod_logs':
      case 'deployment_inspect':
        return action.namespace;
      case 'pods_list':
      case 'deployments_list':
      case 'services_list':
      case 'ingresses_list':
      case 'events_list':
      case 'configmaps_list':
      case 'secrets_list':
        return action.namespace.kind === 'single' ? action.namespace.name : undefined;
      case 'nodes_list':
      case 'cluster_info':
        return undefined;
      default:
        return undefined;
    }
  }

  private nsParam(ns: NamespaceScope | string | undefined): string {
    if (!ns) return '';
    if (typeof ns === 'string') return `/namespaces/${ns}`;
    if (ns.kind === 'single') return `/namespaces/${ns.name}`;
    return ''; // all-namespaces
  }

  private buildPath(action: K8sDiagAction): string {
    const v1 = '/api/v1';
    const apps = '/apis/apps/v1';
    const net = '/apis/networking.k8s.io/v1';

    switch (action.action) {
      case 'pods_list': {
        const params = new URLSearchParams();
        if (action.labelSelector) params.set('labelSelector', action.labelSelector);
        if (action.fieldSelector) params.set('fieldSelector', action.fieldSelector);
        const ns = this.nsParam(action.namespace);
        return `${v1}${ns}/pods${params.toString() ? '?' + params.toString() : ''}`;
      }
      case 'pod_inspect':
        return `${v1}/namespaces/${action.namespace}/pods/${action.podName}`;
      case 'pod_logs': {
        const params = new URLSearchParams();
        params.set('stdout', 'true');
        params.set('stderr', 'true');
        if (action.containerName) params.set('container', action.containerName);
        if (action.tailLines !== undefined) params.set('tailLines', String(action.tailLines));
        if (action.sinceSeconds !== undefined) params.set('sinceSeconds', String(action.sinceSeconds));
        return `${v1}/namespaces/${action.namespace}/pods/${action.podName}/log?${params.toString()}`;
      }
      case 'deployments_list': {
        const ns = this.nsParam(action.namespace);
        return `${apps}${ns}/deployments`;
      }
      case 'deployment_inspect':
        return `${apps}/namespaces/${action.namespace}/deployments/${action.deploymentName}`;
      case 'services_list': {
        const ns = this.nsParam(action.namespace);
        return `${v1}${ns}/services`;
      }
      case 'ingresses_list': {
        const ns = this.nsParam(action.namespace);
        return `${net}${ns}/ingresses`;
      }
      case 'nodes_list':
        return `${v1}/nodes`;
      case 'events_list': {
        const params = new URLSearchParams();
        if (action.involvedObjectKind) params.set('fieldSelector', `involvedObject.kind=${action.involvedObjectKind}`);
        if (action.involvedObjectName) {
          const existing = params.get('fieldSelector');
          params.set('fieldSelector', existing ? `${existing},involvedObject.name=${action.involvedObjectName}` : `involvedObject.name=${action.involvedObjectName}`);
        }
        const ns = this.nsParam(action.namespace);
        return `${v1}${ns}/events${params.toString() ? '?' + params.toString() : ''}`;
      }
      case 'configmaps_list': {
        const ns = this.nsParam(action.namespace);
        return `${v1}${ns}/configmaps`;
      }
      case 'secrets_list': {
        // 警告：K8s secrets API 返回敏感数据，Guard 在工具层做二次过滤
        const ns = this.nsParam(action.namespace);
        return `${v1}${ns}/secrets`;
      }
      case 'cluster_info':
        return `${v1}/namespaces`; // 简单 cluster 可达性检查
      default: {
        const _exhaustive: never = action;
        throw new Error(`K8sGuard: unknown action ${(_exhaustive as K8sDiagAction).action}`);
      }
    }
  }

  private timeoutFor(action: K8sDiagAction): number {
    switch (action.action) {
      case 'pod_logs':
        return 30_000;
      case 'nodes_list':
      case 'events_list':
        return 15_000;
      default:
        return 10_000;
    }
  }
}
