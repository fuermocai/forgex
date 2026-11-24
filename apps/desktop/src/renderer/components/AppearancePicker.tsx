import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ThemeId } from '../theme.js';

interface ThemeOption {
  id: ThemeId;
  name: string;
  description: string;
  canvas: string;
  surface: string;
  accent: string;
}

const themeOptions: ThemeOption[] = [
  { id: 'graphite', name: '石墨蓝', description: '克制的深色工作区', canvas: '#10151c', surface: '#202a36', accent: '#79b8ff' },
  { id: 'paper', name: '浅色纸面', description: '清爽明亮，适合日间', canvas: '#f4f7fb', surface: '#e4ebf3', accent: '#2269b5' },
  { id: 'harbor', name: '海港青', description: '蓝绿底色与薄荷强调色', canvas: '#0e191f', surface: '#1d343b', accent: '#71d4b4' },
];

export function AppearancePicker(props: { themeId: ThemeId; onSelect(themeId: ThemeId): void }) {
  const [isOpen, setIsOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      pickerRef.current?.querySelector<HTMLButtonElement>('.appearance-trigger')?.focus();
    };

    window.addEventListener('pointerdown', closeOnOutsidePointer);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  return (
    <div className="appearance-picker" ref={pickerRef}>
      <button
        className="settings-button appearance-trigger"
        type="button"
        aria-expanded={isOpen}
        aria-label="外观配色"
        onClick={() => setIsOpen((open) => !open)}
      >
        外观
      </button>
      {isOpen && <div className="appearance-panel" role="group" aria-label="选择界面配色">
        <div className="appearance-panel-heading">界面配色</div>
        {themeOptions.map((theme) => {
          const swatchStyle = {
            '--swatch-canvas': theme.canvas,
            '--swatch-surface': theme.surface,
            '--swatch-accent': theme.accent,
          } as CSSProperties;

          return (
            <button
              key={theme.id}
              className={`appearance-option ${props.themeId === theme.id ? 'selected' : ''}`}
              type="button"
              aria-pressed={props.themeId === theme.id}
              aria-label={`${theme.name}：${theme.description}`}
              style={swatchStyle}
              onClick={() => props.onSelect(theme.id)}
            >
              <span className="appearance-swatch" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="appearance-option-copy">
                <span className="appearance-option-name">{theme.name}</span>
                <span className="appearance-option-description">{theme.description}</span>
              </span>
              <span className="appearance-selected-mark" aria-hidden="true" />
            </button>
          );
        })}
      </div>}
    </div>
  );
}
