import { useEffect, useState } from 'react';
import ProblemImage from './ProblemImage';
import LatexRenderer from './LatexRenderer';

export default function ProblemDetailPage({ problemId, api, token, onBack }) {
  const [problem, setProblem] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setProblem(null);
    setError('');
    api.get(`/api/problems/${problemId}/view`)
      .then(({ data }) => {
        if (!cancelled) setProblem(data);
      })
      .catch((requestError) => {
        if (cancelled) return;
        if (requestError.response?.status === 401) {
          setError('Your teacher session has expired. Sign in again to view this problem.');
        } else if (requestError.response?.status === 404 || requestError.response?.status === 403) {
          setError('This problem is not available to this teacher account.');
        } else {
          setError('Could not load this problem. Please try again.');
        }
      });
    return () => { cancelled = true; };
  }, [api, problemId]);

  return (
    <main className="min-h-screen bg-[#f1f6fd] px-4 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-4xl">
        <button
          type="button"
          onClick={onBack}
          className="mb-5 inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-[#2456a6] hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2456a6]"
        >
          ← Back to problem bank
        </button>

        <article className="rounded-2xl border border-[#dbe3ef] bg-white p-5 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold text-[#183b70] sm:text-2xl">Problem {problem?.problem_number ?? problemId}</h1>
          {problem && (
            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                ['Year', problem.year],
                ['Level', problem.level],
                ['Round', problem.round],
                ['Number', problem.problem_number],
                ['Elo', problem.elo],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
                  <dt className="text-xs text-gray-500">{label}</dt>
                  <dd className="mt-1 font-semibold text-gray-800">{value ?? '—'}</dd>
                </div>
              ))}
            </dl>
          )}

          {error && <p role="alert" className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error}</p>}
          {!problem && !error && <p role="status" className="mt-6 text-sm text-gray-600">Loading problem…</p>}
          {problem && (
            <section className="mt-7 border-t border-gray-200 pt-6" aria-labelledby="problem-statement-title">
              <h2 id="problem-statement-title" className="text-base font-semibold text-gray-900">Problem statement</h2>
              <div className="mt-3 whitespace-pre-wrap text-[1.05rem] leading-8 text-gray-800">
                <LatexRenderer text={problem.question} />
              </div>
              {problem.image_url && <ProblemImage url={problem.image_url} token={token} />}
            </section>
          )}
        </article>
      </div>
    </main>
  );
}
