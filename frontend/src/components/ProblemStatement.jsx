import { useState } from 'react';
import LatexRenderer from './LatexRenderer';
import OriginalProblemImage from './OriginalProblemImage';
import ProblemImage from './ProblemImage';

export default function ProblemStatement({ problem, token }) {
  const statement = Boolean(problem.image_url && problem.image_is_statement);
  const [textOpen, setTextOpen] = useState(() => window.matchMedia('(max-width: 639px)').matches);
  return (
    <>
      {statement ? (
        <details className="my-2 text-sm text-gray-700" open={textOpen} onToggle={event => setTextOpen(event.currentTarget.open)}>
          <summary className="w-fit cursor-pointer rounded-sm font-medium text-[#2a61ba] focus-visible:outline focus-visible:outline-offset-2">Text version</summary>
          <div className="mt-2 whitespace-pre-wrap">{problem.question}</div>
          {problem.image_alt && problem.image_alt !== problem.question && <p className="mt-2">{problem.image_alt}</p>}
        </details>
      ) : (
        <div className="whitespace-pre-wrap"><LatexRenderer text={problem.question} /></div>
      )}
      {statement ? (
        <OriginalProblemImage url={problem.image_url} token={token} />
      ) : (
        problem.image_url && <ProblemImage url={problem.image_url} token={token} />
      )}
    </>
  );
}
