/**
 * Docker 只读诊断 Guard。
 *
 * 校验三层：
 *   1. connection 有效性（socketPath 或 tcpUrl 必须有一个）
 *   2. action 必须在 DockerDiagAction 联合类型里（由 Zod discriminatedUnion 保证）
 *   3. 各 action 参数白名单（容器 ID 长度、tail 上限、psArgs 白名单）
 *
 * Guard 本身不做网络请求——只做输入校验和参数规范化。
 */
import { z } from 'zod';
import type { DockerConnection, DockerDiagAction } from './types.js';

/* ------------------------------------------------------------------ */
/* Zod Schema                                                           */
/* ------------------------------------------------------------------ */

// 资源 ID：Docker 容器/镜像 ID 是 hex 字符串（12-64 字符）
const RESOURCE_ID_RE = /^[a-fA-F0-9]{12,64}$/;

const ConnectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('socket'), socketPath: z.string().min(1).max(1024) }),
  z.object({ type: z.literal('tcp'), tcpUrl: z.string().url().max(2048) }),
]);

// 各 action 的 Zod Schema（discriminatedUnion 只接受纯 ZodObject）
const ContainerIdSchema = z.string().regex(RESOURCE_ID_RE, { message: 'containerId 必须是 12-64 位 hex' });
const ImageIdSchema = z.string().min(1).max(256); // 镜像可以是 name:tag 或 ID

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('containers_list'), all: z.boolean().optional(), limit: z.number().int().min(1).max(1000).optional(), filterLabel: z.string().max(128).optional() }),
  z.object({ action: z.literal('container_inspect'), containerId: ContainerIdSchema }),
  z.object({ action: z.literal('container_top'), containerId: ContainerIdSchema, psArgs: z.enum(['-ef', '-aux', '-eo pid,cmd', '-eo pid,user,cmd']).default('-ef') }),
  z.object({ action: z.literal('container_logs'), containerId: ContainerIdSchema, tail: z.number().int().min(1).max(100000).default(500), sinceSec: z.number().int().min(0).max(86_400 * 30).optional() }),
  z.object({ action: z.literal('images_list'), limit: z.number().int().min(1).max(500).optional() }),
  z.object({ action: z.literal('image_inspect'), imageId: ImageIdSchema }),
  z.object({ action: z.literal('networks_list') }),
  z.object({ action: z.literal('volumes_list') }),
  z.object({ action: z.literal('system_info') }),
  z.object({ action: z.literal('version') }),
]);

export interface DockerGuardInput {
  connection: DockerConnection;
  action: DockerDiagAction;
}

export interface GuardedDockerRequest {
  connection: DockerConnection;
  action: DockerDiagAction;
  /** HTTP method（全 GET） */
  method: 'GET';
  /** 路径（已包含 query string） */
  path: string;
  /** 超时毫秒数 */
  timeoutMs: number;
}

/* ------------------------------------------------------------------ */
/* Guard 实现                                                           */
/* ------------------------------------------------------------------ */

export class DockerGuard {
  validate(input: DockerGuardInput): GuardedDockerRequest {
    // 1. connection 校验
    const conn = this.normalizeConnection(input.connection);

    // 2. action Zod 校验
    const action = ActionSchema.parse(input.action) as DockerDiagAction;

    // 3. 构建请求路径
    const path = this.buildPath(action);

    // 4. 超时策略（大响应放宽）
    const timeoutMs = this.timeoutFor(action);

    return {
      connection: conn,
      action,
      method: 'GET',
      path,
      timeoutMs,
    };
  }

  private normalizeConnection(conn: DockerConnection): DockerConnection {
    if ('socketPath' in conn && conn.socketPath) {
      return { socketPath: conn.socketPath };
    }
    if ('tcpUrl' in conn && conn.tcpUrl) {
      return { tcpUrl: conn.tcpUrl };
    }
    throw new Error('DockerGuard: connection 必须提供 socketPath 或 tcpUrl 之一');
  }

  private buildPath(action: DockerDiagAction): string {
    switch (action.action) {
      case 'containers_list': {
        const params = new URLSearchParams();
        if (action.all) params.set('all', 'true');
        if (action.limit) params.set('limit', String(action.limit));
        if (action.filterLabel) {
          // filter Label 需要 JSON 编码
          params.set('filters', JSON.stringify({ label: [action.filterLabel] }));
        }
        return `/containers/json${params.toString() ? '?' + params.toString() : ''}`;
      }
      case 'container_inspect':
        return `/containers/${action.containerId}/json`;
      case 'container_top': {
        const args = new URLSearchParams();
        args.set('ps_args', action.psArgs ?? '-ef');
        return `/containers/${action.containerId}/top?${args.toString()}`;
      }
      case 'container_logs': {
        const params = new URLSearchParams();
        params.set('stdout', 'true');
        params.set('stderr', 'true');
        if (action.tail !== undefined) params.set('tail', String(action.tail));
        if (action.sinceSec !== undefined) params.set('since', String(action.sinceSec));
        return `/containers/${action.containerId}/logs?${params.toString()}`;
      }
      case 'images_list': {
        if (action.limit) {
          return `/images/json?limit=${action.limit}`;
        }
        return '/images/json';
      }
      case 'image_inspect':
        return `/images/${encodeURIComponent(action.imageId)}/json`;
      case 'networks_list':
        return '/networks/json';
      case 'volumes_list':
        return '/volumes';
      case 'system_info':
        return '/info';
      case 'version':
        return '/version';
      default: {
        const _exhaustive: never = action;
        throw new Error(`DockerGuard: unknown action ${(_exhaustive as DockerDiagAction).action}`);
      }
    }
  }

  private timeoutFor(action: DockerDiagAction): number {
    switch (action.action) {
      case 'container_logs':
        return 30_000; // 日志可能较大
      case 'containers_list':
        return 15_000;
      default:
        return 10_000;
    }
  }
}
