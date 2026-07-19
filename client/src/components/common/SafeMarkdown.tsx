import React from 'react';
import ReactMarkdown from 'react-markdown';

interface SafeMarkdownProps {
  content: string;
  className?: string;
}

export function SafeMarkdown({
  content,
  className,
}: SafeMarkdownProps): React.ReactElement {
  return (
    <ReactMarkdown
      className={['app-markdown-content', className].filter(Boolean).join(' ')}
      skipHtml
    >
      {content}
    </ReactMarkdown>
  );
}
