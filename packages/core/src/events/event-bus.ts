/**
 * EventBus：Agent 运行事件的同步分发。
 *
 * 事件只用于 UI / 日志 / 指标观测，不参与控制流；
 * 单个监听器抛错不得影响 Agent 主循环，因此逐个捕获并记录。
 */
import type { AgentEvent, Logger } from '@forgex/shared';

export type AgentEventListener = (event: AgentEvent) => void;

export class EventBus {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly logger: Logger | undefined;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /** 订阅事件，返回取消订阅函数 */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.logger?.warn('事件监听器异常', {
          event: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
