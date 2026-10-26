/**
 * 输入框按键处理测试。
 *
 * 重点回归：Ink 5 把终端 Backspace（`\x7f`）解析成 `key.delete`，
 * 若只按「向后删除」处理，行尾按 Backspace 会删不掉字符。
 */
import { describe, expect, it } from 'vitest';
import { applyInputKey } from '../src/ui/input-edit.js';

const key = (patch: Record<string, boolean> = {}) => ({
  leftArrow: false,
  rightArrow: false,
  backspace: false,
  delete: false,
  ctrl: false,
  meta: false,
  tab: false,
  escape: false,
  upArrow: false,
  downArrow: false,
  ...patch,
});

describe('applyInputKey', () => {
  it('Backspace（Ink 解析为 delete）删除行尾字符', () => {
    expect(applyInputKey({ text: '/planx', cursor: 6 }, '', key({ delete: true }))).toEqual({
      text: '/plan',
      cursor: 5,
    });
  });

  it('backspace 与 delete 行为一致', () => {
    const state = { text: 'hello', cursor: 5 };
    expect(applyInputKey(state, '', key({ backspace: true }))).toEqual(
      applyInputKey(state, '', key({ delete: true })),
    );
  });

  it('光标在行首时退格不会越界', () => {
    expect(applyInputKey({ text: 'abc', cursor: 0 }, '', key({ delete: true }))).toEqual({
      text: 'abc',
      cursor: 0,
    });
  });

  it('光标移动后只删除光标前一个字符', () => {
    expect(applyInputKey({ text: 'abcd', cursor: 2 }, '', key({ delete: true }))).toEqual({
      text: 'acd',
      cursor: 1,
    });
  });

  it('能删除中文等宽字符', () => {
    expect(applyInputKey({ text: '你好世界', cursor: 4 }, '', key({ delete: true }))).toEqual({
      text: '你好世',
      cursor: 3,
    });
  });

  it('左右方向键移动光标', () => {
    expect(applyInputKey({ text: 'abc', cursor: 1 }, '', key({ leftArrow: true }))).toEqual({ text: 'abc', cursor: 0 });
    expect(applyInputKey({ text: 'abc', cursor: 1 }, '', key({ rightArrow: true }))).toEqual({ text: 'abc', cursor: 2 });
  });

  it('Ctrl+A / Ctrl+E 跳到行首与行尾', () => {
    expect(applyInputKey({ text: 'abc', cursor: 1 }, 'a', key({ ctrl: true }))).toEqual({ text: 'abc', cursor: 0 });
    expect(applyInputKey({ text: 'abc', cursor: 1 }, 'e', key({ ctrl: true }))).toEqual({ text: 'abc', cursor: 3 });
  });

  it('Ctrl+U 清空整行', () => {
    expect(applyInputKey({ text: '输错了', cursor: 3 }, 'u', key({ ctrl: true }))).toEqual({ text: '', cursor: 0 });
  });

  it('普通字符插入到光标处', () => {
    expect(applyInputKey({ text: 'ac', cursor: 1 }, 'b', key())).toEqual({ text: 'abc', cursor: 2 });
  });

  it('粘贴的多行文本压平为单行', () => {
    expect(applyInputKey({ text: '', cursor: 0 }, 'a\nb', key())).toEqual({ text: 'a b', cursor: 3 });
  });

  it('空字符（功能键）不产生状态变更', () => {
    expect(applyInputKey({ text: 'abc', cursor: 3 }, '', key())).toBeNull();
  });

  it('Tab / Esc / 上下键被忽略但会消费按键', () => {
    for (const patch of [{ tab: true }, { escape: true }, { upArrow: true }, { downArrow: true }]) {
      expect(applyInputKey({ text: 'abc', cursor: 1 }, '', key(patch))).toEqual({ text: 'abc', cursor: 1 });
    }
  });
});
