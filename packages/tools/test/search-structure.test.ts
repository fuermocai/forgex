/**
 * structure-search.ts 单元测试。
 *
 * 覆盖：五种语言的符号提取、匹配度分级、排序确定性。
 */
import { describe, expect, it } from 'vitest';
import { extractSymbols, splitSymbolName, structureSearch } from '../src/search/structure-search.js';
import type { WalkedFile } from '../src/search/walk.js';

function file(relPath: string, lines: string[]): WalkedFile {
  return { absPath: `/root/${relPath}`, relPath, lines };
}

describe('extractSymbols: TypeScript', () => {
  it('提取函数/类/接口/类型/变量/导入/方法', () => {
    const f = file('src/a.ts', [
      "import { readFile } from 'node:fs/promises';",
      'export interface UserConfig {',
      '  name: string;',
      '}',
      'export type UserId = string;',
      'export const DEFAULT_TIMEOUT = 5000;',
      'export async function loadUser(id: UserId) {',
      '  return id;',
      '}',
      'export class UserService {',
      '  async findUser(id: string): Promise<string> {',
      '    return id;',
      '  }',
      '}',
      'enum Role { Admin }',
    ]);
    const symbols = extractSymbols(f);
    const byName = new Map(symbols.map((s) => [s.name, s.kind]));
    expect(byName.get('node:fs/promises')).toBe('import');
    expect(byName.get('UserConfig')).toBe('interface');
    expect(byName.get('UserId')).toBe('type');
    expect(byName.get('DEFAULT_TIMEOUT')).toBe('variable');
    expect(byName.get('loadUser')).toBe('function');
    expect(byName.get('UserService')).toBe('class');
    expect(byName.get('findUser')).toBe('method');
    expect(byName.get('Role')).toBe('enum');
  });

  it('控制流关键字不会被误判为方法', () => {
    const f = file('src/b.ts', [
      'function demo() {',
      '  if (x) {',
      '    return;',
      '  }',
      '  for (const i of list) {',
      '  }',
      '}',
    ]);
    const symbols = extractSymbols(f);
    expect(symbols.filter((s) => s.kind === 'method')).toHaveLength(0);
    expect(symbols.some((s) => s.name === 'demo' && s.kind === 'function')).toBe(true);
  });
});

describe('extractSymbols: 其他语言', () => {
  it('Python: def/class/import', () => {
    const f = file('app/main.py', [
      'import os',
      'from typing import Optional',
      'class Server:',
      '    pass',
      'def start_server(port: int):',
      '    pass',
      'async def stop_server():',
      '    pass',
    ]);
    const byName = new Map(extractSymbols(f).map((s) => [s.name, s.kind]));
    expect(byName.get('os')).toBe('import');
    expect(byName.get('typing')).toBe('import');
    expect(byName.get('Server')).toBe('class');
    expect(byName.get('start_server')).toBe('function');
    expect(byName.get('stop_server')).toBe('function');
  });

  it('Go: func/method/struct/interface', () => {
    const f = file('cmd/server.go', [
      'type Config struct {',
      '}',
      'type Handler interface {',
      '}',
      'func NewConfig() *Config {',
      '}',
      'func (c *Config) Validate() error {',
      '}',
    ]);
    const byName = new Map(extractSymbols(f).map((s) => [s.name, s.kind]));
    expect(byName.get('Config')).toBe('struct');
    expect(byName.get('Handler')).toBe('interface');
    expect(byName.get('NewConfig')).toBe('function');
    expect(byName.get('Validate')).toBe('method');
  });

  it('Rust: fn/struct/enum/trait/impl', () => {
    const f = file('src/lib.rs', [
      'pub struct Engine {',
      '}',
      'pub enum Mode {',
      '}',
      'pub trait Runner {',
      '}',
      'impl Engine {',
      '}',
      'pub fn start_engine() {',
      '}',
    ]);
    const byName = new Map(extractSymbols(f).map((s) => [s.name, s.kind]));
    expect(byName.get('Engine')).toBe('struct');
    expect(byName.get('Mode')).toBe('enum');
    expect(byName.get('Runner')).toBe('trait');
    expect(byName.get('start_engine')).toBe('function');
  });

  it('Java: class/interface/method', () => {
    const f = file('src/Server.java', [
      'public class Server {',
      '    public void start(int port) {',
      '    }',
      '}',
      'public interface Lifecycle {',
      '}',
    ]);
    const byName = new Map(extractSymbols(f).map((s) => [s.name, s.kind]));
    expect(byName.get('Server')).toBe('class');
    expect(byName.get('start')).toBe('method');
    expect(byName.get('Lifecycle')).toBe('interface');
  });

  it('未知后缀返回空符号列表', () => {
    const f = file('notes.txt', ['function fake() {}']);
    expect(extractSymbols(f)).toEqual([]);
  });
});

describe('splitSymbolName', () => {
  it('拆分驼峰', () => {
    expect(splitSymbolName('getUserName')).toEqual(['get', 'user', 'name']);
  });

  it('拆分下划线', () => {
    expect(splitSymbolName('max_retry_count')).toEqual(['max', 'retry', 'count']);
  });

  it('处理全大写缩写', () => {
    expect(splitSymbolName('HTTPSConnection')).toEqual(['https', 'connection']);
  });
});

describe('structureSearch', () => {
  const files: WalkedFile[] = [
    file('src/auth.ts', [
      'export function loginUser(name: string) {',
      '}',
      'export function logoutUser() {',
      '}',
      'export class AuthManager {',
      '}',
    ]),
    file('src/net.ts', ['export function fetchData(url: string) {', '}']),
  ];

  it('精确匹配得分最高', () => {
    const hits = structureSearch({ tokens: ['loginuser'], files, maxHits: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.symbol).toBe('loginUser');
    expect(hits[0]!.symbolKind).toBe('function');
    expect(hits[0]!.score).toBeGreaterThan(0.9);
  });

  it('驼峰部件命中（user -> loginUser/logoutUser）', () => {
    const hits = structureSearch({ tokens: ['user'], files, maxHits: 10 });
    const names = hits.map((h) => h.symbol);
    expect(names).toContain('loginUser');
    expect(names).toContain('logoutUser');
  });

  it('子串匹配（auth -> AuthManager）', () => {
    const hits = structureSearch({ tokens: ['auth'], files, maxHits: 10 });
    expect(hits.some((h) => h.symbol === 'AuthManager')).toBe(true);
  });

  it('无匹配返回空数组', () => {
    expect(structureSearch({ tokens: ['nonexistent'], files, maxHits: 10 })).toEqual([]);
  });

  it('空 token 返回空数组', () => {
    expect(structureSearch({ tokens: [], files, maxHits: 10 })).toEqual([]);
  });

  it('遵守 maxHits 上限', () => {
    const many = file('many.ts', Array.from({ length: 50 }, (_, i) => `export function target${i}() {}`));
    const hits = structureSearch({ tokens: ['target'], files: [many], maxHits: 5 });
    expect(hits).toHaveLength(5);
  });

  it('结果按得分降序，得分相同按路径行号稳定排序', () => {
    const tieFiles: WalkedFile[] = [
      file('b.ts', ['export function alpha() {}']),
      file('a.ts', ['export function alpha() {}']),
    ];
    const hits = structureSearch({ tokens: ['alpha'], files: tieFiles, maxHits: 10 });
    expect(hits.map((h) => h.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('命中行 snippet 是符号定义行', () => {
    const hits = structureSearch({ tokens: ['fetchdata'], files, maxHits: 10 });
    expect(hits[0]!.snippet).toContain('fetchData');
    expect(hits[0]!.line).toBe(1);
  });
});
