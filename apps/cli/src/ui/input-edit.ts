/**
 * TUI 输入框的按键处理（纯函数，便于单测）。
 *
 * 关于 Backspace：
 * Ink 5 的 parseKeypress 把 `\x7f` 解析成 `delete`，而 xterm、VS Code、
 * Windows Terminal 等终端的 Backspace 发出的正是 `\x7f`；真正的 Delete 键
 * （`\x1b[3~`）同样被解析成 `delete`，Ink 无法区分两者。
 * 因此这里把 backspace / delete 都按退格处理，否则光标在行尾时按 Backspace
 * 会走「向后删除」分支而毫无反应。
 */

export interface EditKeyState {
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  tab?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

export interface EditState {
  text: string;
  cursor: number;
}

/**
 * 根据一次按键计算新的输入状态。
 *
 * @returns 新状态；`null` 表示该按键是普通字符且无需处理（非文本输入）。
 */
export function applyInputKey(state: EditState, char: string, key: EditKeyState): EditState | null {
  const chars = Array.from(state.text);
  const at = Math.min(Math.max(0, state.cursor), chars.length);

  if (key.leftArrow) return { text: state.text, cursor: Math.max(0, at - 1) };
  if (key.rightArrow) return { text: state.text, cursor: Math.min(chars.length, at + 1) };
  if (key.ctrl && (char === 'a' || char === 'A')) return { text: state.text, cursor: 0 };
  if (key.ctrl && (char === 'e' || char === 'E')) return { text: state.text, cursor: chars.length };
  if (key.ctrl && (char === 'u' || char === 'U')) return { text: '', cursor: 0 };

  // Backspace（`\x7f`）与 Delete 在 Ink 中不可区分，统一按退格处理。
  if (key.backspace || key.delete) {
    if (at === 0) return { text: state.text, cursor: 0 };
    chars.splice(at - 1, 1);
    return { text: chars.join(''), cursor: at - 1 };
  }

  if (key.ctrl || key.meta || key.tab || key.escape || key.upArrow || key.downArrow) {
    return { text: state.text, cursor: at };
  }

  if (!char) return null;

  // 粘贴多行文本时压平为单行，避免破坏 TUI 布局。
  const clean = char.replace(/[\r\n]+/g, ' ');
  if (!clean) return { text: state.text, cursor: at };

  const inserted = Array.from(clean);
  chars.splice(at, 0, ...inserted);
  return { text: chars.join(''), cursor: at + inserted.length };
}
