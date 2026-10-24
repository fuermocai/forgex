/**
 * Docker Guard + Client 骨架单元测试。
 *
 * 只验证输入校验和请求路径构建（Guard 的 Zod 部分和 buildPath）。
 * 不发真实 HTTP 请求（本机 Windows 通常无 Docker Desktop）。
 */
import { describe, expect, it } from 'vitest';
import { DockerGuard } from '../src/docker/docker-guard.js';

describe('DockerGuard', () => {
  const guard = new DockerGuard();
  const validConn = { socketPath: '/var/run/docker.sock' };

  it('containers_list → /containers/json', () => {
    const req = guard.validate({ connection: validConn, action: { action: 'containers_list' } });
    expect(req.path).toBe('/containers/json');
    expect(req.method).toBe('GET');
  });

  it('containers_list all+limit → query string 正确', () => {
    const req = guard.validate({ connection: validConn, action: { action: 'containers_list', all: true, limit: 50 } });
    expect(req.path).toContain('/containers/json?');
    expect(req.path).toContain('all=true');
    expect(req.path).toContain('limit=50');
  });

  it('container_inspect → /containers/{id}/json', () => {
    const req = guard.validate({ connection: validConn, action: { action: 'container_inspect', containerId: 'a1b2c3d4e5f6' } });
    expect(req.path).toBe('/containers/a1b2c3d4e5f6/json');
  });

  it('container_inspect 非法容器 ID → Zod 拒绝', () => {
    expect(() =>
      guard.validate({ connection: validConn, action: { action: 'container_inspect', containerId: 'not-a-hex-id' as any } }),
    ).toThrow();
  });

  it('container_logs 默认 tail=500', () => {
    const req = guard.validate({ connection: validConn, action: { action: 'container_logs', containerId: 'a1b2c3d4e5f6' } });
    expect(req.path).toContain('tail=500');
    expect(req.path).toContain('stdout=true');
    expect(req.path).toContain('stderr=true');
  });

  it('container_logs tail 上限 100000 → Zod 拒绝超限', () => {
    expect(() =>
      guard.validate({ connection: validConn, action: { action: 'container_logs', containerId: 'a1b2c3d4e5f6', tail: 200000 } }),
    ).toThrow();
  });

  it('version → /version', () => {
    const req = guard.validate({ connection: validConn, action: { action: 'version' } });
    expect(req.path).toBe('/version');
  });

  it('system_info → /info', () => {
    const req = guard.validate({ connection: validConn, action: { action: 'system_info' } });
    expect(req.path).toBe('/info');
  });

  it('tcpUrl 连接正常', () => {
    const req = guard.validate({
      connection: { tcpUrl: 'tcp://localhost:2375' },
      action: { action: 'version' },
    });
    expect(req.path).toBe('/version');
  });

  it('两种连接都没提供 → 拒绝', () => {
    expect(() =>
      guard.validate({ connection: {} as any, action: { action: 'version' } }),
    ).toThrow();
  });

  it('所有 action 都是 GET 方法', () => {
    const actions: any[] = [
      { action: 'containers_list' },
      { action: 'container_inspect', containerId: 'a1b2c3d4e5f6' },
      { action: 'container_top', containerId: 'a1b2c3d4e5f6' },
      { action: 'container_logs', containerId: 'a1b2c3d4e5f6' },
      { action: 'images_list' },
      { action: 'image_inspect', imageId: 'myapp:latest' },
      { action: 'networks_list' },
      { action: 'volumes_list' },
      { action: 'system_info' },
      { action: 'version' },
    ];
    for (const a of actions) {
      const req = guard.validate({ connection: validConn, action: a });
      expect(req.method).toBe('GET');
    }
  });

  it('logs 超时 30s，其他默认 10s', () => {
    const logsReq = guard.validate({ connection: validConn, action: { action: 'container_logs', containerId: 'a1b2c3d4e5f6' } });
    expect(logsReq.timeoutMs).toBe(30_000);

    const infoReq = guard.validate({ connection: validConn, action: { action: 'system_info' } });
    expect(infoReq.timeoutMs).toBe(10_000);
  });
});
