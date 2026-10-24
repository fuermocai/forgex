/**
 * K8s Guard 单元测试。
 *
 * 只验证 Zod 校验 + API path 构建 + 命名空间白名单。不发真实 HTTP。
 */
import { describe, expect, it } from 'vitest';
import { K8sGuard } from '../src/kubernetes/k8s-guard.js';

describe('K8sGuard', () => {
  const guard = new K8sGuard();
  const validConn = { apiServerUrl: 'https://k8s.example.com:6443' };

  it('pods_list single namespace → /api/v1/namespaces/xxx/pods', () => {
    const req = guard.validate({
      connection: validConn,
      action: { action: 'pods_list', namespace: { kind: 'single', name: 'default' } },
    });
    expect(req.path).toBe('/api/v1/namespaces/default/pods');
  });

  it('pods_list all → /api/v1/pods', () => {
    const req = guard.validate({
      connection: validConn,
      action: { action: 'pods_list', namespace: { kind: 'all' } },
    });
    expect(req.path).toBe('/api/v1/pods');
  });

  it('pods_list labelSelector → query string', () => {
    const req = guard.validate({
      connection: validConn,
      action: {
        action: 'pods_list',
        namespace: { kind: 'single', name: 'default' },
        labelSelector: 'app=web,env=prod',
      },
    });
    expect(req.path).toContain('labelSelector=app%3Dweb%2Cenv%3Dprod');
  });

  it('pod_logs 默认 tailLines=2000', () => {
    const req = guard.validate({
      connection: validConn,
      action: { action: 'pod_logs', namespace: 'default', podName: 'my-pod-abc' },
    });
    expect(req.path).toContain('tailLines=2000');
    expect(req.path).toContain('stdout=true');
    expect(req.path).toContain('stderr=true');
    expect(req.path).toContain('/api/v1/namespaces/default/pods/my-pod-abc/log');
  });

  it('deployments_list → apps/v1', () => {
    const req = guard.validate({
      connection: validConn,
      action: { action: 'deployments_list', namespace: { kind: 'single', name: 'kube-system' } },
    });
    expect(req.path).toBe('/apis/apps/v1/namespaces/kube-system/deployments');
  });

  it('ingresses_list → networking.k8s.io/v1', () => {
    const req = guard.validate({
      connection: validConn,
      action: { action: 'ingresses_list', namespace: { kind: 'all' } },
    });
    expect(req.path).toBe('/apis/networking.k8s.io/v1/ingresses');
  });

  it('nodes_list → /api/v1/nodes', () => {
    const req = guard.validate({ connection: validConn, action: { action: 'nodes_list' } });
    expect(req.path).toBe('/api/v1/nodes');
  });

  it('cluster_info → /api/v1/namespaces', () => {
    const req = guard.validate({ connection: validConn, action: { action: 'cluster_info' } });
    expect(req.path).toBe('/api/v1/namespaces');
  });

  it('非法命名空间名 → Zod 拒绝', () => {
    expect(() =>
      guard.validate({
        connection: validConn,
        action: { action: 'pod_inspect', namespace: 'UPPERCASE_BAD', podName: 'x' },
      }),
    ).toThrow();
  });

  it('命名空间白名单外 → Guard 拒绝', () => {
    expect(() =>
      guard.validate({
        connection: validConn,
        action: { action: 'pod_inspect', namespace: 'default', podName: 'my-pod' },
        allowedNamespaces: ['prod', 'staging'],
      }),
    ).toThrow(/不在白名单/);
  });

  it('命名空间白名单内 → 通过', () => {
    const req = guard.validate({
      connection: validConn,
      action: { action: 'pod_inspect', namespace: 'prod', podName: 'my-pod' },
      allowedNamespaces: ['prod', 'staging'],
    });
    expect(req.path).toBe('/api/v1/namespaces/prod/pods/my-pod');
  });

  it('all-namespaces 绕过白名单限制', () => {
    const req = guard.validate({
      connection: validConn,
      action: { action: 'pods_list', namespace: { kind: 'all' } },
      allowedNamespaces: ['prod'],
    });
    expect(req.path).toBe('/api/v1/pods');
  });

  it('kubeconfigPath 连接正常', () => {
    const req = guard.validate({
      connection: { kubeconfigPath: '/home/user/.kube/config' },
      action: { action: 'cluster_info' },
    });
    expect(req.path).toBe('/api/v1/namespaces');
  });

  it('pod_logs 超时 30s，其他默认 10s', () => {
    const logsReq = guard.validate({
      connection: validConn,
      action: { action: 'pod_logs', namespace: 'default', podName: 'x' },
    });
    expect(logsReq.timeoutMs).toBe(30_000);

    const nodesReq = guard.validate({ connection: validConn, action: { action: 'nodes_list' } });
    expect(nodesReq.timeoutMs).toBe(15_000);
  });

  it('所有 action 都是 GET', () => {
    const reqs = [
      guard.validate({ connection: validConn, action: { action: 'pods_list', namespace: { kind: 'all' } } }),
      guard.validate({ connection: validConn, action: { action: 'nodes_list' } }),
      guard.validate({ connection: validConn, action: { action: 'services_list', namespace: { kind: 'single', name: 'default' } } }),
      guard.validate({ connection: validConn, action: { action: 'cluster_info' } }),
    ];
    for (const r of reqs) expect(r.method).toBe('GET');
  });
});
