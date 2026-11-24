import { useEffect, useRef, useState } from 'react';
import type { DesktopMessage } from '../../shared/desktop-api.js';
import { MarkdownMessage } from './MarkdownMessage.js';

export interface ToolActivity {
  callId: string;
  name: string;
  status: 'running' | 'done' | 'failed';
  detail?: string;
}

interface ChatMessage extends DesktopMessage {
  id: string;
}

export function ChatView(props: {
  messages: ChatMessage[];
  streamingText: string;
  tools: ToolActivity[];
  busy: boolean;
  error: string;
  notice: string;
  onSend(text: string): void;
  onCancel(): void;
}) {
  const [input, setInput] = useState('');
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && followLatestRef.current) element.scrollTop = element.scrollHeight;
  }, [props.messages, props.streamingText, props.tools]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    followLatestRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    setShowJumpToLatest(!followLatestRef.current);
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (!element) return;
    followLatestRef.current = true;
    setShowJumpToLatest(false);
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  };

  const submit = () => {
    const text = input.trim();
    if (!text || props.busy) return;
    props.onSend(text);
    setInput('');
  };

  return (
    <div className="chat-view">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {props.messages.length === 0 && !props.busy && <div className="chat-empty"><h2>你想在这个项目里做什么？</h2><p>描述目标、问题或需要实现的功能。</p></div>}
        {props.messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
          <div className="message-role">{message.role === 'user' ? '你' : 'ForgeX'}</div>
          <div className="message-content">{message.role === 'assistant' ? <MarkdownMessage content={message.content} /> : message.content}</div>
        </article>)}
        {props.streamingText && <article className="message assistant"><div className="message-role">ForgeX</div><div className="message-content"><MarkdownMessage content={props.streamingText} /><span className="cursor-block">▍</span></div></article>}
        {props.tools.filter((tool) => tool.status === 'running').map((tool) => <div className="tool-activity" key={tool.callId}><span className="tool-pulse" />{tool.name}<span>运行中</span></div>)}
      </div>
      {showJumpToLatest && <button className="jump-to-latest" onClick={jumpToLatest}>↓ 最新消息</button>}
      <div className="composer-area">
        {props.error && <div className="inline-error banner-error">{props.error}</div>}
        {props.notice && <div className="chat-notice">{props.notice}</div>}
        <div className="composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="描述你要完成的任务…（Shift+Enter 换行）"
            rows={3}
          />
          <div className="composer-footer">
            <span>Enter 发送 · Shift+Enter 换行</span>
            {props.busy
              ? <button className="cancel-button" onClick={props.onCancel}>取消任务</button>
              : <button className="send-button" onClick={submit} disabled={!input.trim()}>发送 ↑</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
