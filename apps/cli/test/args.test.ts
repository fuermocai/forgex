/**
 * CLI 参数解析测试。
 *
 * 重点覆盖：
 *  - 子命令 / 位置参数 / 长参数 / 短参数 / `--` 终止符；
 *  - `--key=value` 与 `--key value` 两种取值写法；
 *  - 未知参数检测（`--doctor` 这类拼写错误不能再静默进入 chat）。
 */
import { describe, expect, it } from 'vitest';
import { flagBool, flagNumber, flagString, flagsMissingValue, parseArgs, unknownFlags } from '../src/args.js';

describe('parseArgs', () => {
  it('无子命令时默认为 chat', () => {
    expect(parseArgs([]).command).toBe('chat');
    expect(parseArgs([]).positionals).toEqual([]);
  });

  it('解析子命令与位置参数', () => {
    const args = parseArgs(['run', '修复', '登录', 'bug']);
    expect(args.command).toBe('run');
    expect(args.positionals).toEqual(['修复', '登录', 'bug']);
  });

  it('解析 --key=value', () => {
    const args = parseArgs(['run', '--model=deepseek-flash', '--json']);
    expect(args.command).toBe('run');
    expect(flagString(args.flags, 'model')).toBe('deepseek-flash');
    expect(flagBool(args.flags, 'json')).toBe(true);
  });

  it('解析 --key value（仅已知取值参数）', () => {
    const args = parseArgs(['sessions', '--limit', '5', '--config', 'a.json']);
    expect(flagNumber(args.flags, 'limit')).toBe(5);
    expect(flagString(args.flags, 'config')).toBe('a.json');
  });

  it('未知长参数不会被吞掉下一个位置参数', () => {
    const args = parseArgs(['run', '--doctor', 'task']);
    expect(flagBool(args.flags, 'doctor')).toBe(true);
    expect(args.positionals).toEqual(['task']);
  });

  it('解析短参数', () => {
    const args = parseArgs(['-h']);
    expect(args.flags.h).toBe(true);
    expect(args.command).toBe('chat');
  });

  it('-- 之后的全部作为位置参数', () => {
    const args = parseArgs(['run', '--', '--json', '-v']);
    expect(args.command).toBe('run');
    expect(args.positionals).toEqual(['--json', '-v']);
    expect(args.flags).toEqual({});
  });

  it('flagString 不把布尔 true 当成字符串', () => {
    const args = parseArgs(['--config']);
    expect(args.flags.config).toBe(true);
    expect(flagString(args.flags, 'config')).toBeUndefined();
  });

  it('flagNumber 对非法值返回 undefined', () => {
    const args = parseArgs(['sessions', '--limit', 'abc']);
    expect(flagNumber(args.flags, 'limit')).toBeUndefined();
  });

  it('--mode 取值，--plan 是布尔开关', () => {
    const args = parseArgs(['chat', '--mode', 'trusted', '--plan']);
    expect(flagString(args.flags, 'mode')).toBe('trusted');
    expect(flagBool(args.flags, 'plan')).toBe(true);

    // --mode 属于取值参数：紧跟的位置参数不能被吞成取值
    const runArgs = parseArgs(['run', '--mode=yolo', '整理日志']);
    expect(flagString(runArgs.flags, 'mode')).toBe('yolo');
    expect(runArgs.positionals).toEqual(['整理日志']);
  });
});

describe('unknownFlags', () => {
  it('已知参数返回空数组', () => {
    const args = parseArgs([
      'connect',
      '--provider',
      'deepseek',
      '--api-key',
      'sk-test',
      '--model',
      'deepseek-flash',
      '--base-url',
      'https://api.deepseek.com',
      '--plain',
      '--json',
      '--yes',
      '--full',
      '--config',
      'x.json',
      '--session',
      's_1',
      '--limit',
      '3',
      '--mode',
      'readonly',
      '--plan',
    ]);
    expect(unknownFlags(args.flags)).toEqual([]);
  });

  it('识别拼写错误的长参数', () => {
    expect(unknownFlags(parseArgs(['--doctor']).flags)).toEqual(['doctor']);
    expect(unknownFlags(parseArgs(['run', '--jsn']).flags)).toEqual(['jsn']);
  });

  it('识别未知短参数', () => {
    expect(unknownFlags(parseArgs(['-x']).flags)).toEqual(['x']);
  });
});

describe('flagsMissingValue', () => {
  it('取值参数漏写值时返回参数名', () => {
    expect(flagsMissingValue(parseArgs(['sessions', '--limit']).flags)).toEqual(['limit']);
    expect(flagsMissingValue(parseArgs(['--config']).flags)).toEqual(['config']);
    expect(flagsMissingValue(parseArgs(['chat', '--mode']).flags)).toEqual(['mode']);
  });

  it('正常取值与布尔开关不误报', () => {
    expect(flagsMissingValue(parseArgs(['sessions', '--limit', '5']).flags)).toEqual([]);
    expect(flagsMissingValue(parseArgs(['--json', '--plain']).flags)).toEqual([]);
  });
});
