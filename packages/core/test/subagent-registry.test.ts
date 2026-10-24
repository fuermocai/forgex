/**
 * AgentRegistry 单元测试（v0.3.0 Phase 2）。
 */
import { describe, expect, it } from 'vitest';
import { ForgeError } from '@forgex/shared';
import {
  AgentRegistry,
  getSharedAgentRegistry,
} from '../src/subagent/agent-registry.js';

describe('AgentRegistry 基础查询', () => {
  it('listRoles 返回四种角色', () => {
    const registry = new AgentRegistry();
    const roles = registry.listRoles();
    expect(roles).toHaveLength(4);
    expect(roles).toContain('explorer');
    expect(roles).toContain('debugger');
    expect(roles).toContain('reviewer');
    expect(roles).toContain('worker');
  });

  it('hasRole 正确识别', () => {
    const registry = new AgentRegistry();
    expect(registry.hasRole('explorer')).toBe(true);
    expect(registry.hasRole('worker')).toBe(true);
    expect(registry.hasRole('admin')).toBe(false);
    expect(registry.hasRole('')).toBe(false);
    expect(registry.hasRole(null)).toBe(false);
  });
});

describe('AgentRegistry 工具白名单', () => {
  it('explorer 白名单只含只读 coding 工具', () => {
    const registry = new AgentRegistry();
    const tools = registry.getWhitelist('explorer');
    expect(tools).toContain('read_file');
    expect(tools).toContain('grep_search');
    expect(tools).not.toContain('edit_file');
    expect(tools).not.toContain('run_command');
    expect(tools).not.toContain('ssh_inspect');
  });

  it('debugger 白名单含系统诊断但不含修改类', () => {
    const registry = new AgentRegistry();
    const tools = registry.getWhitelist('debugger');
    expect(tools).toContain('inspect_process');
    expect(tools).toContain('inspect_memory');
    expect(tools).toContain('read_logs');
    expect(tools).toContain('ssh_inspect');
    expect(tools).not.toContain('edit_file');
    expect(tools).not.toContain('run_command');
  });

  it('reviewer 白名单与 explorer 类似但更聚焦', () => {
    const registry = new AgentRegistry();
    const tools = registry.getWhitelist('reviewer');
    expect(tools).toContain('git_diff');
    expect(tools).toContain('git_status');
    expect(tools).not.toContain('edit_file');
    expect(tools).not.toContain('run_command');
    expect(tools).not.toContain('ssh_inspect');
    expect(tools).not.toContain('inspect_process');
  });

  it('worker 白名单含修改类但不含 ssh', () => {
    const registry = new AgentRegistry();
    const tools = registry.getWhitelist('worker');
    expect(tools).toContain('edit_file');
    expect(tools).toContain('run_command');
    expect(tools).toContain('read_file');
    expect(tools).not.toContain('ssh_inspect');
    expect(tools).not.toContain('inspect_process');
  });

  it('getWhitelist 返回副本——外部修改不影响内部', () => {
    const registry = new AgentRegistry();
    const tools1 = registry.getWhitelist('explorer');
    const original = tools1.length;
    tools1.push('hack_tool');
    const tools2 = registry.getWhitelist('explorer');
    expect(tools2).toHaveLength(original);
    expect(tools2).not.toContain('hack_tool');
  });
});

describe('AgentRegistry 系统提示词', () => {
  it('每种角色都有非空系统提示词', () => {
    const registry = new AgentRegistry();
    for (const role of registry.listRoles()) {
      const prompt = registry.getSystemPrompt(role);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(50);
    }
  });

  it('系统提示词包含角色名', () => {
    const registry = new AgentRegistry();
    expect(registry.getSystemPrompt('explorer')).toContain('explorer');
    expect(registry.getSystemPrompt('debugger')).toContain('debugger');
    expect(registry.getSystemPrompt('reviewer')).toContain('reviewer');
    expect(registry.getSystemPrompt('worker')).toContain('worker');
  });

  it('系统提示词强调"严格禁止"边界', () => {
    const registry = new AgentRegistry();
    for (const role of registry.listRoles()) {
      const prompt = registry.getSystemPrompt(role);
      expect(prompt).toContain('禁止');
    }
  });
});

describe('AgentRegistry isToolAllowedForRole', () => {
  it('白名单内工具返回 true', () => {
    const registry = new AgentRegistry();
    expect(registry.isToolAllowedForRole('explorer', 'read_file')).toBe(true);
    expect(registry.isToolAllowedForRole('worker', 'edit_file')).toBe(true);
  });

  it('白名单外工具返回 false', () => {
    const registry = new AgentRegistry();
    expect(registry.isToolAllowedForRole('explorer', 'edit_file')).toBe(false);
    expect(registry.isToolAllowedForRole('reviewer', 'run_command')).toBe(false);
  });

  it('未知名称工具返回 false', () => {
    const registry = new AgentRegistry();
    expect(registry.isToolAllowedForRole('explorer', 'hack_tool')).toBe(false);
  });
});

describe('AgentRegistry intersectWithParent', () => {
  it('父任务白名单 ⊇ 角色白名单 → 返回完整角色白名单', () => {
    const registry = new AgentRegistry();
    const parentTools = ['read_file', 'list_directory', 'grep_search', 'git_status', 'git_diff', 'correlate_code_runtime', 'edit_file'];
    const result = registry.intersectWithParent('explorer', parentTools);
    expect(result).toEqual(registry.getWhitelist('explorer'));
  });

  it('父任务白名单 ⊂ 角色白名单 → 返回交集', () => {
    const registry = new AgentRegistry();
    const parentTools = ['read_file', 'grep_search'];
    const result = registry.intersectWithParent('explorer', parentTools);
    expect(result).toEqual(['read_file', 'grep_search']);
  });

  it('父任务白名单为空 → 返回空数组', () => {
    const registry = new AgentRegistry();
    const result = registry.intersectWithParent('explorer', []);
    expect(result).toEqual([]);
  });

  it('worker 白名单 ∩ 只读父任务 → 只剩只读工具', () => {
    const registry = new AgentRegistry();
    const parentTools = ['read_file', 'grep_search', 'git_status'];
    const result = registry.intersectWithParent('worker', parentTools);
    expect(result).toContain('read_file');
    expect(result).toContain('grep_search');
    expect(result).not.toContain('edit_file');
    expect(result).not.toContain('run_command');
  });

  it('debugger 白名单 ∩ 无 SSH 的父任务 → 移除 ssh_inspect', () => {
    const registry = new AgentRegistry();
    const parentTools = ['read_file', 'inspect_process', 'inspect_memory', 'read_logs'];
    const result = registry.intersectWithParent('debugger', parentTools);
    expect(result).not.toContain('ssh_inspect');
    expect(result).toContain('inspect_process');
  });
});

describe('getSharedAgentRegistry', () => {
  it('两次调用返回同一实例', () => {
    const r1 = getSharedAgentRegistry();
    const r2 = getSharedAgentRegistry();
    expect(r1).toBe(r2);
  });
});
