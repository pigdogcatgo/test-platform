import { lazy, Suspense } from 'react';

const MathContent = lazy(() => import('./RenderLatex'));

export default function LatexRenderer({ text }) {
  if (!text) return null;
  if (!text.includes('$')) return text;

  return (
    <Suspense fallback={<span aria-label="Loading formula" className="text-gray-500">…</span>}>
      <MathContent text={text} />
    </Suspense>
  );
}
