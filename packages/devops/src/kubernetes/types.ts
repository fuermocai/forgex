/**
 * Kubernetes 只读诊断：类型定义。
 *
 * 走 Kubernetes API Server 只读 GET（不走 kubectl CLI）：
 *   GET /api/v1/namespaces/{ns}/pods
 *   GET /api/v1/namespaces/{ns}/pods/{name}
 *   GET /api/v1/namespaces/{ns}/pods/{name}/logs
 *   GET /apis/apps/v1/namespaces/{ns}/deployments
 *   GET /apis/apps/v1/namespaces/{ns}/deployments/{name}
 *   GET /api/v1/namespaces/{ns}/services
 *   GET /apis/networking.k8s.io/v1/namespaces/{ns}/ingresses
 *   GET /api/v1/nodes
 *   GET /api/v1/namespaces/{ns}/events
 *   GET /api/v1/namespaces/{ns}/configmaps
 *   GET /api/v1/namespaces/{ns}/secrets （注意：只看元数据，不看 data/stringData）
 */

/** K8s 连接配置 */
export type K8sConnection =
  | {
      /** kubeconfig 文件路径 */
      kubeconfigPath: string;
    }
  | {
      /** Apiserver URL + bearer token（in-cluster 或外部直连） */
      apiServerUrl: string;
      bearerToken?: string;
      caCertPath?: string;
    };

/** 命名空间范围 */
export type NamespaceScope =
  | { kind: 'single'; name: string }
  | { kind: 'all' };

/** 诊断动作（结构化，禁止任意 API path） */
export type K8sDiagAction =
  | { action: 'pods_list'; namespace: NamespaceScope; labelSelector?: string; fieldSelector?: string }
  | { action: 'pod_inspect'; namespace: string; podName: string }
  | { action: 'pod_logs'; namespace: string; podName: string; containerName?: string; tailLines?: number; sinceSeconds?: number }
  | { action: 'deployments_list'; namespace: NamespaceScope }
  | { action: 'deployment_inspect'; namespace: string; deploymentName: string }
  | { action: 'services_list'; namespace: NamespaceScope }
  | { action: 'ingresses_list'; namespace: NamespaceScope }
  | { action: 'nodes_list' }
  | { action: 'events_list'; namespace: NamespaceScope; involvedObjectKind?: string; involvedObjectName?: string }
  | { action: 'configmaps_list'; namespace: NamespaceScope }
  | { action: 'secrets_list'; namespace: NamespaceScope }
  | { action: 'cluster_info' };

/** Pod 摘要（列表视图） */
export interface PodSummary {
  name: string;
  namespace: string;
  uid: string;
  nodeName: string;
  status: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
  phase: string;
  ready: string; // e.g. "2/3"
  restarts: number;
  age: string;
  labels: Record<string, string>;
  podIP?: string;
  startTime?: string;
}

/** Deployment 摘要 */
export interface DeploymentSummary {
  name: string;
  namespace: string;
  replicas: number;
  ready: number;
  updated: number;
  available: number;
  strategy: string;
  age: string;
  conditions: Array<{ type: string; status: string; message?: string }>;
}

/** Service 摘要 */
export interface ServiceSummary {
  name: string;
  namespace: string;
  type: string;
  clusterIP: string;
  externalIPs: string[];
  ports: Array<{ port: number; targetPort: number; protocol: string }>;
  age: string;
}

/** Ingress 摘要 */
export interface IngressSummary {
  name: string;
  namespace: string;
  className?: string;
  hosts: string[];
  paths: number;
  age: string;
}

/** Node 摘要 */
export interface NodeSummary {
  name: string;
  osImage: string;
  kernelVersion: string;
  containerRuntimeVersion: string;
  kubeletVersion: string;
  ready: boolean;
  cpu: number;
  memoryBytes: number;
  podCapacity: number;
}

/** Event 摘要 */
export interface EventSummary {
  name: string;
  namespace: string;
  reason: string;
  message: string;
  involvedObjectKind: string;
  involvedObjectName: string;
  count: number;
  type: 'Normal' | 'Warning';
  lastTimestamp?: string;
  eventTime?: string;
}

/** ConfigMap 摘要（不含 data） */
export interface ConfigMapSummary {
  name: string;
  namespace: string;
  dataKeys: string[];
  age: string;
}

/** Secret 摘要（不含 data/stringData） */
export interface SecretSummary {
  name: string;
  namespace: string;
  type: string;
  dataKeys: string[];
  age: string;
}
