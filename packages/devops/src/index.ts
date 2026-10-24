/**
 * @forgex/devops：本机只读诊断 + SSH 远程诊断。
 *
 * 第一版仅支持 Linux / Windows 本机；第二版新增 SSH 远程只读诊断
 * （通过结构化 action 白名单执行，禁止任意 shell 字符串）。
 */
import { ForgeError } from '@forgex/shared';
import { currentPlatform, type DiskInfo, type MemoryInfo, type PortInfo, type ProcessInfo } from './types.js';
import { listLinuxProcesses } from './linux/processes.js';
import { listLinuxPorts } from './linux/ports.js';
import { listLinuxDisks } from './linux/disk.js';
import { getLinuxMemory } from './linux/memory.js';
import { listWindowsProcesses } from './windows/processes.js';
import { listWindowsPorts } from './windows/ports.js';
import { listWindowsDisks } from './windows/disk.js';
import { getWindowsMemory } from './windows/memory.js';

export * from './types.js';
export { readLogTail } from './logs.js';
export type { ReadLogTailOptions } from './logs.js';

/* SSH 远程诊断 */
export { SshGuard } from './ssh/ssh-guard.js';
export type { GuardedSpec, SshCommand } from './ssh/ssh-guard.js';
export { SshClient } from './ssh/ssh-client.js';
export type {
  SshHostConfig,
  SshExecSpec,
  SshExecuteResult,
  SshConnectOptions,
  RemoteDiagAction,
} from './ssh/types.js';

/* Phase 4：代码 + 运行环境关联分析 */
export { correlate } from './correlation/correlate.js';
export { detectLanguage, parseStack } from './correlation/stack-parser.js';
export { aggregateLogEvents } from './correlation/log-aggregator.js';
export { correlateWithGit } from './correlation/git-correlator.js';
export type {
  CorrelateOptions,
  CorrelationReport,
  LogEvent,
  StackFrame,
  GitChange,
  Severity,
  Language,
} from './correlation/types.js';

/* Docker 只读诊断 */
export { DockerGuard } from './docker/docker-guard.js';
export type { GuardedDockerRequest } from './docker/docker-guard.js';
export { DockerClient } from './docker/docker-client.js';
export type { DockerApiError, DockerExecuteResult } from './docker/docker-client.js';
export type {
  DockerConnection,
  DockerDiagAction,
  ContainerSummary,
  ContainerInspectLite,
  ImageSummary,
  NetworkSummary,
  VolumeSummary,
  DockerSystemInfoLite,
  DockerVersion,
} from './docker/types.js';

/* Kubernetes 只读诊断 */
export { K8sGuard } from './kubernetes/k8s-guard.js';
export type { GuardedK8sRequest } from './kubernetes/k8s-guard.js';
export type {
  K8sConnection,
  K8sDiagAction,
  NamespaceScope,
  PodSummary,
  DeploymentSummary,
  ServiceSummary,
  IngressSummary,
  NodeSummary,
  EventSummary,
  ConfigMapSummary,
  SecretSummary,
} from './kubernetes/types.js';

/** 列出全部进程（按内存占用降序，Linux 侧可用） */
export async function listProcesses(): Promise<ProcessInfo[]> {
  const platform = currentPlatform();
  if (platform === 'linux') return listLinuxProcesses();
  if (platform === 'windows') return listWindowsProcesses();
  throw new ForgeError('TOOL_FAILED', `当前平台 ${process.platform} 暂不支持进程诊断`);
}

/** 列出全部端口（含监听与已建立连接） */
export async function listPorts(options: { listeningOnly?: boolean } = {}): Promise<PortInfo[]> {
  const platform = currentPlatform();
  if (platform === 'linux') return listLinuxPorts(options);
  if (platform === 'windows') return listWindowsPorts(options);
  throw new ForgeError('TOOL_FAILED', `当前平台 ${process.platform} 暂不支持端口诊断`);
}

/** 列出本地磁盘使用情况 */
export async function listDisks(): Promise<DiskInfo[]> {
  const platform = currentPlatform();
  if (platform === 'linux') return listLinuxDisks();
  if (platform === 'windows') return listWindowsDisks();
  throw new ForgeError('TOOL_FAILED', `当前平台 ${process.platform} 暂不支持磁盘诊断`);
}

/** 读取内存与 swap 状态 */
export async function getMemory(): Promise<MemoryInfo> {
  const platform = currentPlatform();
  if (platform === 'linux') return getLinuxMemory();
  if (platform === 'windows') return getWindowsMemory();
  throw new ForgeError('TOOL_FAILED', `当前平台 ${process.platform} 暂不支持内存诊断`);
}
