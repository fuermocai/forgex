import { ForgeError, type AgentEvent } from '@forgex/shared';
import type { RegisteredTool, ToolRegistry } from '@forgex/tools';
import type { EventBus } from '../events/event-bus.js';

export interface ExtensionCommand {
  name: string;
  description: string;
  execute(args: string): void | Promise<void>;
}
export interface ForgeExtension {
  id: string;
  activate(api: ExtensionApi): void;
}
export interface ExtensionApi {
  registerTool(tool: RegisteredTool): void;
  registerCommand(command: ExtensionCommand): void;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}

/** Trusted in-process extension registry. Registered tools still pass through ToolDispatcher policy and audit. */
export class ExtensionRegistry {
  private readonly commands = new Map<string, ExtensionCommand>();
  private readonly ids = new Set<string>();
  private readonly reservedCommands = new Set(['exit', 'quit', 'help', 'session', 'queue', 'queue-remove', 'followup', 'context', 'plan', 'mode', 'models', 'model', 'key', 'connect']);

  activate(extensions: ReadonlyArray<ForgeExtension>, tools: ToolRegistry, events: EventBus): void {
    for (const extension of extensions) {
      if (!/^[a-z][a-z0-9._-]{1,63}$/i.test(extension.id) || this.ids.has(extension.id)) {
        throw new ForgeError('CONFIG_INVALID', `扩展 ID 非法或重复: ${extension.id}`);
      }
      this.ids.add(extension.id);
      extension.activate({
        registerTool: (tool) => tools.register(tool),
        registerCommand: (command) => {
          if (!/^[a-z][a-z0-9-]{0,31}$/.test(command.name) || this.reservedCommands.has(command.name) || this.commands.has(command.name)) {
            throw new ForgeError('CONFIG_INVALID', `扩展命令名非法或重复: ${command.name}`);
          }
          if (!command.description.trim()) throw new ForgeError('CONFIG_INVALID', `扩展命令缺少说明: ${command.name}`);
          this.commands.set(command.name, command);
        },
        onEvent: (listener) => events.on(listener),
      });
    }
  }

  listCommands(): ExtensionCommand[] { return [...this.commands.values()]; }
  async executeCommand(name: string, args: string): Promise<boolean> {
    const command = this.commands.get(name);
    if (!command) return false;
    await command.execute(args);
    return true;
  }
}
