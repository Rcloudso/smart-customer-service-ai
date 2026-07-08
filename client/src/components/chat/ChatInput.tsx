import React, { useState, useRef, useCallback } from 'react';
import { Textarea, Button } from 'tdesign-react';
import { SendIcon } from 'tdesign-icons-react';
import { useTranslation } from '../../hooks/usePreferences';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

/**
 * Chat input component with Enter-to-send and Shift+Enter for newline.
 */
export function ChatInput({ onSend, disabled = false }: ChatInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation();

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    // Refocus textarea after sending
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (_value: string, context: { e: React.KeyboardEvent<HTMLTextAreaElement> }) => {
      const e = context.e;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      className="app-chat-input-dock"
    >
      <Textarea
        ref={textareaRef as React.Ref<HTMLTextAreaElement> as any}
        value={value}
        onChange={(val: string) => setValue(val)}
        onKeydown={handleKeyDown}
        placeholder={t('chat.inputPlaceholder')}
        disabled={disabled}
        autosize={{ minRows: 1, maxRows: 4 }}
        style={{ flex: 1 }}
        data-testid="chat-input"
      />
      <Button
        theme="primary"
        shape="circle"
        icon={<SendIcon />}
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        className="app-chat-send-button"
        data-testid="chat-send-button"
      />
    </div>
  );
}
