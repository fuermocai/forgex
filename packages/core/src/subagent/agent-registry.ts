/**
 * AgentRegistry：四种 Sub-Agent 角色的注册表（v0.3.0 Phase 2）。
 *
 * 职责：
 *   1. 为每种角色定义默认工具白名单（explorer/debugger/reviewer/worker）；
 *   2. 为每种角色定义默认系统提示词模板；
 *   3. 提供查询接口 getWhitelist(role) / getSystemPrompt(role)；
 *   4. 白名单只是"默认上限"——实际生效还要经过 DelegationManager 的父任务收敛。
 *
 * 关键设计：
 *   - 所有白名单都是字符串数组，与 @forgex/tools 里的工具名一一对应；
 *   - 白名单故意只列已实现的工具，不预留"未来可能"的占位符——避免模型
 *      在工具不存在时反复尝试；
 *   - 系统提示词强调"职责边界"——让模型知道自己不该越界；
 *   - 本注册表是只读的（构造后不允许修改），保证多个子代理并发安全。
 */
import { ForgeError } from '@forgex/shared';
import { isSubAgentRole, type SubAgentRole } from './types.js';

/* ------------------------------------------------------------------ */
/* 工具白名单定义                                                       */
/* ------------------------------------------------------------------ */

/**
 * explorer：代码探索——只读 coding 工具 + 关联分析。
 * 不给：edit_file / run_command / ssh_inspect / 系统诊断。
 */
const EXPLORER_TOOLS: ReadonlyArray<string> = [
  'read_file',
  'list_directory',
  'grep_search',
  'git_status',
  'git_diff',
  'correlate_code_runtime',
];

/**
 * debugger：运行时诊断——只读 coding + 只读系统诊断 + SSH 远程诊断。
 * 不给：edit_file / run_command（防止误修改/误执行）。
 */
const DEBUGGER_TOOLS: ReadonlyArray<string> = [
  'read_file',
  'list_directory',
  'grep_search',
  'git_status',
  'git_diff',
  'inspect_process',
  'inspect_port',
  'inspect_disk',
  'inspect_memory',
  'read_logs',
  'correlate_code_runtime',
  'ssh_inspect',
];

/**
 * reviewer：变更审查——只读 coding + 关联分析。
 * 不给：edit_file / run_command / 系统诊断（reviewer 只需要看代码和 diff）。
 */
const REVIEWER_TOOLS: ReadonlyArray<string> = [
  'read_file',
  'list_directory',
  'grep_search',
  'git_status',
  'git_diff',
  'correlate_code_runtime',
];

/**
 * worker：执行修改——所有 coding 工具 + run_command。
 * 不给：ssh_inspect（生产环境操作不应下放给 worker）、系统诊断（worker 专注代码改动）。
 * 注意：worker 的默认上限只是"最大可能"，实际生效仍受父任务白名单收敛。
 */
const WORKER_TOOLS: ReadonlyArray<string> = [
  'read_file',
  'list_directory',
  'grep_search',
  'edit_file',
  'git_status',
  'git_diff',
  'run_command',
  'correlate_code_runtime',
];

/* ------------------------------------------------------------------ */
/* 系统提示词模板                                                       */
/* ------------------------------------------------------------------ */

/**
 * 系统提示词强调三件事：
 *   1. 角色定位（你是谁）
 *   2. 职责边界（你不该做什么）
 *   3. 输出格式（让父任务能解析你的结果）
 */
const SYSTEM_PROMPTS: Record<SubAgentRole, string> = {
  explorer: `你是一个代码探索子代理（explorer）。
你的职责：在指定工作区内定位文件、符号、引用关系，为父任务收集足够的代码上下文。

严格禁止：
- 不要修改任何文件（你没有 edit_file 工具）
- 不要执行任何命令（你没有 run_command 工具）
- 不要尝试 SSH / 容器 / 进程诊断（那不是你的职责）

工作方式：
1. 用 list_directory 了解目录结构
2. 用 grep_search 定位关键符号 / 关键词
3. 用 read_file 读取目标文件
4. 用 git_status / git_diff 了解当前变更
5. 用 correlate_code_runtime 关联代码与运行时（如果需要）

输出要求：
- 最后一条助手消息必须是结构化的"探索结论"，包含：
  - 关键文件列表（路径 + 作用）
  - 关键符号 / 函数 / 类型定义位置（文件:行号）
  - 与任务相关的代码片段引用
  - 任何需要注意的潜在风险或不一致`,

  debugger: `你是一个运行时诊断子代理（debugger）。
你的职责：只读检查系统状态（进程 / 端口 / 磁盘 / 内存 / 日志 / 容器），为父任务定位运行时问题的根因。

严格禁止：
- 不要修改任何文件（你没有 edit_file 工具）
- 不要执行任何命令（你没有 run_command 工具，除了只读的 inspect_* / read_logs / ssh_inspect）
- 不要重启服务、不要杀进程、不要清理磁盘——你是只读的

工作方式：
1. 用 inspect_process / inspect_port 定位可疑进程与监听
2. 用 inspect_memory / inspect_disk 检查资源瓶颈
3. 用 read_logs 收集关键错误日志（只取相关时间窗）
4. 用 ssh_inspect 在已配置的远程主机上做只读诊断（如果任务涉及远程）
5. 用 correlate_code_runtime 把运行时证据反推回代码位置

输出要求：
- 最后一条助手消息必须是结构化的"诊断报告"，包含：
  - 根因假设（按可能性排序）
  - 支撑每个假设的证据（日志行 / 进程信息 / 端口数据 / 代码位置）
  - 建议的修复方向（不要直接动手修）
  - 需要父任务进一步确认的问题`,

  reviewer: `你是一个变更审查子代理（reviewer）。
你的职责：读取代码 diff、相关文件与上下文，产出结构化审查意见。

严格禁止：
- 不要修改任何文件（你没有 edit_file 工具）
- 不要执行任何命令（你没有 run_command 工具）
- 不要审查工作区外的代码——只看父任务指定的范围

审查维度：
1. 正确性：逻辑错误、边界条件、错误处理
2. 安全性：注入风险、权限越界、敏感信息泄露
3. 可维护性：命名、注释、复杂度、重复代码
4. 一致性：与项目现有风格 / 架构的匹配度

工作方式：
1. 用 git_status / git_diff 拿到全部变更
2. 用 read_file 读取受影响的完整文件（理解上下文）
3. 用 grep_search 找类似模式（看是否一致处理）
4. 用 correlate_code_runtime 看变更是否影响运行时行为

输出要求：
- 最后一条助手消息必须是结构化的"审查意见"，包含：
  - 每个发现按严重级别分类（blocker / major / minor / nit）
  - 每个发现都带：文件:行号、问题描述、修复建议、理由
  - 整体评价（是否建议合并、需要哪些修改）`,

  worker: `你是一个执行子代理（worker）。
你的职责：在父任务白名单范围内，完成具体的代码修改、文件创建、命令执行。

严格禁止：
- 不要超出父任务给定的工具白名单（即使你"觉得"需要其他工具）
- 不要 SSH 到任何主机（你没有 ssh_inspect 工具）
- 不要修改与任务无关的文件——保持最小变更

工作方式：
1. 先用 read_file / grep_search 理解目标代码
2. 用 edit_file 做最小必要的修改
3. 用 run_command 跑测试 / 构建验证（如果父任务允许）
4. 用 git_status / git_diff 检查变更是否符合预期

输出要求：
- 最后一条助手消息必须是结构化的"执行报告"，包含：
  - 修改了哪些文件（路径 + 简述变更内容）
  - 跑了哪些命令（命令 + 退出码 + 关键输出）
  - 变更是否达成目标（自我验证）
  - 遗留问题 / 需要父任务接管的部分`,
};

/* ------------------------------------------------------------------ */
/* AgentRegistry                                                       */
/* ------------------------------------------------------------------ */

/**
 * 角色注册表（只读）。
 *
 * 提供：
 *   - getWhitelist(role)：角色默认工具白名单（返回副本，防止外部修改）
 *   - getSystemPrompt(role)：角色系统提示词
 *   - listRoles()：全部已注册角色
 *   - isToolAllowedForRole(role, tool)：判断某工具是否在角色白名单内
 */
export class AgentRegistry {
  private readonly whitelists: ReadonlyMap<SubAgentRole, ReadonlyArray<string>>;
  private readonly prompts: ReadonlyMap<SubAgentRole, string>;

  constructor() {
    this.whitelists = new Map<SubAgentRole, ReadonlyArray<string>>([
      ['explorer', EXPLORER_TOOLS],
      ['debugger', DEBUGGER_TOOLS],
      ['reviewer', REVIEWER_TOOLS],
      ['worker', WORKER_TOOLS],
    ]);
    this.prompts = new Map<SubAgentRole, string>([
      ['explorer', SYSTEM_PROMPTS.explorer],
      ['debugger', SYSTEM_PROMPTS.debugger],
      ['reviewer', SYSTEM_PROMPTS.reviewer],
      ['worker', SYSTEM_PROMPTS.worker],
    ]);
  }

  /** 列出所有已注册角色 */
  listRoles(): SubAgentRole[] {
    return [...this.whitelists.keys()];
  }

  /** 检查角色是否已注册 */
  hasRole(role: unknown): role is SubAgentRole {
    return isSubAgentRole(role) && this.whitelists.has(role);
  }

  /** 获取角色的工具白名单（返回副本，防止外部修改） */
  getWhitelist(role: SubAgentRole): string[] {
    const list = this.whitelists.get(role);
    if (!list) {
      throw new ForgeError('SUBAGENT_ROLE_UNKNOWN', `未注册的子代理角色: ${role}`);
    }
    return [...list];
  }

  /** 获取角色的系统提示词 */
  getSystemPrompt(role: SubAgentRole): string {
    const prompt = this.prompts.get(role);
    if (!prompt) {
      throw new ForgeError('SUBAGENT_ROLE_UNKNOWN', `未注册的子代理角色: ${role}`);
    }
    return prompt;
  }

  /** 检查工具是否在角色白名单内 */
  isToolAllowedForRole(role: SubAgentRole, toolName: string): boolean {
    const list = this.whitelists.get(role);
    if (!list) return false;
    return list.includes(toolName);
  }

  /**
   * 计算"角色白名单 ∩ 父任务白名单"——返回允许生效的工具集合。
   * 这是 DelegationManager 在分派前的核心收敛逻辑。
   */
  intersectWithParent(role: SubAgentRole, parentTools: ReadonlyArray<string>): string[] {
    const roleTools = this.whitelists.get(role) ?? [];
    const parentSet = new Set(parentTools);
    return roleTools.filter((tool) => parentSet.has(tool));
  }
}

/** 模块级单例（只读，全局共享） */
let sharedRegistry: AgentRegistry | undefined;

/** 获取共享注册表（首次调用时创建） */
export function getSharedAgentRegistry(): AgentRegistry {
  if (!sharedRegistry) sharedRegistry = new AgentRegistry();
  return sharedRegistry;
}
