/**
 * WorkspaceGuard：文件系统边界防护。
 *
 * 威胁模型：
 *  - 模型生成 `../../etc/passwd` 之类的路径穿越；
 *  - 工作区内存在指向工作区外的符号链接（`ln -s / C:\link`）；
 *  - 通过相对路径 + 大小写差异绕过前缀判断（Windows）。
 *
 * 对策：
 *  - 所有路径先做 `realpath`（对不存在的目标，取"最深的已存在祖先"再拼接剩余部分）；
 *  - 用 `path.relative` 判断包含关系，而不是字符串 startsWith；
 *  - 写入额外检查 writableRoots 与 protectedPaths；
 *  - 任何越界都抛 `WORKSPACE_ESCAPE`，调用方不得吞掉。
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { ForgeError } from '@forgex/shared';

export type WorkspaceAccess = 'read' | 'write';

export interface WorkspaceGuardOptions {
  /** 允许读取的根目录（绝对或相对路径，内部会 realpath 并转绝对） */
  roots: string[];
  /** 允许写入的根目录，默认等于 roots */
  writableRoots?: string[];
  /** 写入受保护路径（相对 roots 或绝对路径） */
  protectedPaths?: string[];
}

export class WorkspaceGuard {
  private readonly rawRoots: string[];
  private readonly rawWritableRoots: string[];
  private readonly rawProtectedPaths: string[];
  private rootsPromise: Promise<string[]> | null = null;
  private writablePromise: Promise<string[]> | null = null;
  private protectedPromise: Promise<string[]> | null = null;

  constructor(options: WorkspaceGuardOptions) {
    if (!Array.isArray(options.roots) || options.roots.length === 0) {
      throw new ForgeError('CONFIG_INVALID', 'WorkspaceGuard 至少需要一个授权根目录');
    }
    this.rawRoots = options.roots.map((root) => resolvePath(root));
    this.rawWritableRoots = (options.writableRoots ?? options.roots).map((root) => resolvePath(root));
    this.rawProtectedPaths = [...(options.protectedPaths ?? [])];
  }

  /** 读取根目录（realpath 后），供工具展示 */
  async roots(): Promise<string[]> {
    this.rootsPromise ??= this.realpathAll(this.rawRoots);
    return this.rootsPromise;
  }

  /**
   * 把用户/模型提供的路径解析为工作区内的真实绝对路径。
   * @param target 相对或绝对路径
   * @param mode   read / write
   * @param cwd    相对路径的基准目录（默认第一个根目录）
   */
  async resolve(target: string, mode: WorkspaceAccess, cwd?: string): Promise<string> {
    if (typeof target !== 'string' || target.trim().length === 0) {
      throw new ForgeError('CONFIG_INVALID', '路径不能为空');
    }
    if (target.includes('\0')) {
      throw new ForgeError('WORKSPACE_ESCAPE', '路径包含非法空字符', { details: { target } });
    }

    const roots = await this.roots();
    const base = cwd ? resolvePath(cwd) : (roots[0] ?? this.rawRoots[0]!);
    const absolute = isAbsolute(target) ? resolvePath(target) : resolvePath(base, target);
    const real = await this.realpathNearest(absolute);

    const readAllowed = roots.some((root) => isInside(root, real));
    if (!readAllowed) {
      throw new ForgeError('WORKSPACE_ESCAPE', `路径超出授权工作区: ${target}`, {
        details: { target, resolved: real, roots },
      });
    }

    if (mode === 'write') {
      const writable = await this.writableRoots();
      if (!writable.some((root) => isInside(root, real))) {
        throw new ForgeError('WORKSPACE_ESCAPE', `路径不在可写目录内: ${target}`, {
          details: { target, resolved: real, writableRoots: writable },
        });
      }
      const protectedRoots = await this.protectedPaths();
      const hit = protectedRoots.find((p) => isInside(p, real));
      if (hit) {
        throw new ForgeError('POLICY_DENIED', `路径命中受保护目录，禁止写入: ${target}`, {
          details: { target, resolved: real, protectedPath: hit },
        });
      }
    }

    return real;
  }

  private async writableRoots(): Promise<string[]> {
    this.writablePromise ??= this.realpathAll(this.rawWritableRoots);
    return this.writablePromise;
  }

  /** 展开受保护路径为绝对真实路径（相对路径会拼到每个 root 下） */
  private async protectedPaths(): Promise<string[]> {
    this.protectedPromise ??= (async () => {
      const roots = await this.roots();
      const out: string[] = [];
      for (const p of this.rawProtectedPaths) {
        if (isAbsolute(p)) {
          out.push(await this.realpathNearest(resolvePath(p)));
          continue;
        }
        for (const root of roots) {
          out.push(await this.realpathNearest(join(root, p)));
        }
      }
      return out;
    })();
    return this.protectedPromise;
  }

  private async realpathAll(paths: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const p of paths) {
      try {
        out.push(await realpath(p));
      } catch (err) {
        throw new ForgeError('CONFIG_INVALID', `授权根目录不存在或不可访问: ${p}`, {
          details: { path: p },
          cause: err,
        });
      }
    }
    return out;
  }

  /**
   * 解析路径中"最深的已存在祖先"，再把不存在的尾部拼回去。
   * 这样既能对新建文件做边界判断，又能正确跟随符号链接。
   */
  private async realpathNearest(target: string): Promise<string> {
    let current = target;
    const suffix: string[] = [];
    for (;;) {
      try {
        const real = await realpath(current);
        return suffix.length > 0 ? join(real, ...suffix.reverse()) : real;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw new ForgeError('PATH_NOT_FOUND', `无法解析路径: ${target}`, {
            details: { path: target, code: code ?? 'UNKNOWN' },
            cause: err,
          });
        }
        const parent = resolvePath(current, '..');
        if (parent === current) {
          // 到达根目录仍不存在（例如 Windows 上未挂载的盘符），退回规范化路径
          return resolvePath(target);
        }
        suffix.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
        current = parent;
      }
    }
  }
}

/** 判断 child 是否位于 parent 之内（含相等）；大小写按平台处理 */
export function isInside(parent: string, child: string): boolean {
  const from = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const to = process.platform === 'win32' ? child.toLowerCase() : child;
  const rel = relative(from, to);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  // 额外防御：`..` 后跟分隔符
  return !rel.split(sep).includes('..');
}
