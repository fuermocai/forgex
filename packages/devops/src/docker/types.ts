/**
 * Docker 只读诊断：类型定义。
 *
 * Docker Engine API 走只读 GET 端点（不走 docker CLI）：
 *   GET /containers/json              — 列表容器（支持 all=true）
 *   GET /containers/{id}/json         — 容器详情
 *   GET /containers/{id}/top          — 容器内进程列表
 *   GET /containers/{id}/logs         — 容器日志（支持 tail/since）
 *   GET /images/json                  — 列表镜像
 *   GET /images/{id}/json             — 镜像详情
 *   GET /networks/json                — 列表网络
 *   GET /volumes                      — 列表卷
 *   GET /system/info                  — Docker 守护进程信息
 *   GET /version                      — Docker 版本
 */

/** Docker 连接配置（二选一） */
export type DockerConnection =
  | {
      /** Unix socket 路径（Linux 默认 /var/run/docker.sock，macOS ~/.docker/run/docker.sock） */
      socketPath: string;
      tcpUrl?: never;
    }
  | {
      /** TCP URL（如 tcp://localhost:2375 或 tcp://0.0.0.0:2376） */
      tcpUrl: string;
      socketPath?: never;
    };

/** 诊断动作（结构化，禁止任意端点） */
export type DockerDiagAction =
  | { action: 'containers_list'; all?: boolean; limit?: number; filterLabel?: string }
  | { action: 'container_inspect'; containerId: string }
  | { action: 'container_top'; containerId: string; psArgs?: string }
  | { action: 'container_logs'; containerId: string; tail?: number; sinceSec?: number }
  | { action: 'images_list'; limit?: number }
  | { action: 'image_inspect'; imageId: string }
  | { action: 'networks_list' }
  | { action: 'volumes_list' }
  | { action: 'system_info' }
  | { action: 'version' };

/** 容器摘要（containers/json 返回） */
export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Command: string;
  Created: number;
  Ports: Array<{ IP?: string; PrivatePort: number; PublicPort?: number; Type: string }>;
  Status: string;
  State: 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';
  Labels: Record<string, string>;
  SizeRw?: number;
  SizeRootFs?: number;
}

/** 容器详情关键字段 */
export interface ContainerInspectLite {
  Id: string;
  Name: string;
  Image: string;
  State: {
    Status: string;
    Running: boolean;
    StartedAt: string;
    FinishedAt: string;
    ExitCode: number;
  };
  Config: {
    Cmd: string[];
    Env: string[];
    Labels: Record<string, string>;
    Image: string;
  };
  HostConfig: {
    Memory: number;
    Cpus: number;
    NetworkMode: string;
    RestartPolicy: { Name: string; MaximumRetryCount: number };
  };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
  NetworkSettings: {
    IPAddress: string;
    Networks: Record<string, { IPAddress: string; NetworkID: string }>;
  };
}

/** 镜像摘要 */
export interface ImageSummary {
  Id: string;
  RepoTags: string[];
  Created: number;
  Size: number;
  VirtualSize: number;
  Labels?: Record<string, string>;
}

/** 网络摘要 */
export interface NetworkSummary {
  Id: string;
  Name: string;
  Type: string;
  Driver: string;
  Scope: string;
  Containers: Record<string, { Name: string; IPv4Address: string; IPv6Address: string }>;
}

/** 卷摘要 */
export interface VolumeSummary {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Labels?: Record<string, string>;
  UsedSize?: number;
}

/** 系统信息（精简版） */
export interface DockerSystemInfoLite {
  ServerVersion: string;
  OperatingSystem: string;
  Architecture: string;
  KernelVersion: string;
  Containers: number;
  ContainersRunning: number;
  ContainersPaused: number;
  ContainersStopped: number;
  Images: number;
  Driver: string;
  CgroupDriver: string;
  MemTotal: number;
  NCPU: number;
  DockerRootDir: string;
}

/** 版本信息 */
export interface DockerVersion {
  Version: string;
  ApiVersion: string;
  GoVersion: string;
  OS: string;
  Arch: string;
  KernelVersion: string;
  BuildTime: string;
}
