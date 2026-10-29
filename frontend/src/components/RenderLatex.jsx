import 'katex/dist/katex.min.css';
import React, { memo } from 'react';
import katex from 'katex';

const katexOptions = {
  displayMode: false,
  throwOnError: false,
  macros: { '\\usepackage': '' },
  strict: false,
};

function RenderLatex({ text }) {
  if (!text) return null;

  const fixLatex = (math) => (math || '').replace(/\\neq\b/g, '\\ne');
  const renderMath = (math, display, key) => {
    try {
      const html = katex.renderToString(fixLatex(math), { ...katexOptions, displayMode: display });
      return <span key={key} dangerouslySetInnerHTML={{ __html: html }} />;
    } catch {
      return <span key={key} className="text-red-600">[{math}]</span>;
    }
  };

  const parts = [];
  let lastIndex = 0;
  const regex = /\$\$(.+?)\$\$|\$(.+?)\$/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<React.Fragment key={`text-${lastIndex}`}>{text.substring(lastIndex, match.index)}</React.Fragment>);
    }
    if (match[1]) {
      parts.push(renderMath(match[1], true, `math-${match.index}`));
    } else if (match[2]) {
      parts.push(renderMath(match[2], false, `math-${match.index}`));
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(<React.Fragment key={`text-${lastIndex}`}>{text.substring(lastIndex)}</React.Fragment>);
  }
  return <>{parts}</>;
}

export default memo(RenderLatex);
