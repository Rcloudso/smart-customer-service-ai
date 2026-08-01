import React from 'react';
import ReactMarkdown from 'react-markdown';

const SAFE_MARKDOWN_COMPONENTS = {
  img: () => null,
};

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
      components={SAFE_MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
}
