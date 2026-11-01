import { useEffect, useMemo, useState } from 'react';

export default function PrototypeInsights({ api, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    api.get('/api/insights/class')
      .then(response => {
        if (active) setData(response.data);
      })
      .catch(requestError => {
        if (!active) return;
        setData(null);
        setError(requestError.response?.data?.error || 'Could not load aggregate class insights.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [api, retryCount]);

  const topics = useMemo(() => Array.isArray(data?.topics) ? data.topics : [], [data]);
  const problems = useMemo(() => Array.isArray(data?.problems) ? data.problems : [], [data]);
  const aggregate = useMemo(() => {
    const responses = topics.reduce((sum, topic) => sum + (Number(topic.responses) || 0), 0);
    const weightedCorrect = topics.reduce(
      (sum, topic) => sum + (Number(topic.responses) || 0) * (Number(topic.accuracy_percent) || 0),
      0
    );
    return {
      responses,
      averageAccuracy: responses > 0 ? Math.round(weightedCorrect / responses) : null,
    };
  }, [topics]);

  return (
    <main className="min-h-screen bg-[#f1f6fd]">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-5 shadow-sm">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#2a61ba]">Class insights</p>
            <h1 className="mt-1 text-xl font-semibold text-gray-900">Practice trends</h1>
          </div>
          <button type="button" onClick={onBack} className="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-semibold text-[#2a61ba] hover:bg-gray-50 focus-visible:outline">
            Back to dashboard
          </button>
        </header>

        <div className="mb-6 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm leading-6 text-indigo-950" role="note">
          <strong>Aggregate class data only.</strong> Groups below the server’s minimum cohort size are suppressed. No student names, IDs, or individual attempt records are shown.
        </div>

        {loading && <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600" role="status">Loading aggregate class insights…</div>}

        {!loading && error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-900" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => { setError(''); setLoading(true); setRetryCount(count => count + 1); }} className="mt-3 min-h-10 rounded-lg border border-red-300 bg-white px-3 font-semibold text-red-900 hover:bg-red-100 focus-visible:outline">
              Retry loading insights
            </button>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <Metric label="Aggregate responses" value={aggregate.responses.toLocaleString()} detail="Across reportable topic groups" />
              <Metric label="Average accuracy" value={aggregate.averageAccuracy == null ? '—' : `${aggregate.averageAccuracy}%`} detail="Weighted across reportable responses" />
              <Metric label="Reportable topics" value={topics.length} detail={`Minimum group size: ${data?.minimumCohort ?? 'server policy'}`} />
              <Metric label="Reportable problems" value={problems.length} detail="Question-level groups meeting the privacy threshold" />
            </div>

            <section className="mt-6 rounded-xl bg-white p-5 shadow-sm" aria-labelledby="topic-trends-title">
              <div className="mb-4">
                <h2 id="topic-trends-title" className="text-base font-semibold text-gray-900">Accuracy by topic</h2>
                <p className="mt-1 text-sm text-gray-600">Only server-approved aggregate groups are included.</p>
              </div>
              {topics.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600" role="status">No topic groups meet the minimum privacy threshold yet.</p>
              ) : (
                <div className="space-y-5">
                  {topics.map(topic => {
                    const accuracy = Math.max(0, Math.min(100, Number(topic.accuracy_percent) || 0));
                    return (
                      <div key={topic.topic}>
                        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                          <span className="font-medium text-gray-800">{topic.topic}</span>
                          <span className="text-gray-600">{accuracy}% correct · {topic.responses} responses</span>
                        </div>
                        <div className="h-2.5 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-label={`${topic.topic} aggregate accuracy`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={accuracy}>
                          <div className="h-full rounded-full bg-[#2a61ba]" style={{ width: `${accuracy}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="mt-6 rounded-xl bg-white p-5 shadow-sm" aria-labelledby="problem-trends-title">
              <div className="mb-4">
                <h2 id="problem-trends-title" className="text-base font-semibold text-gray-900">Problem difficulty and accuracy</h2>
                <p className="mt-1 text-sm text-gray-600">Difficulty levels are fictional catalog estimates. Accuracy reflects only groups meeting the server privacy threshold.</p>
              </div>
              {problems.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600" role="status">No individual problem group meets the minimum privacy threshold yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                        <th scope="col" className="py-3 pr-4">Topic</th>
                        <th scope="col" className="py-3 pr-4">Catalog difficulty</th>
                        <th scope="col" className="py-3 pr-4">Class accuracy</th>
                        <th scope="col" className="py-3">Responses</th>
                      </tr>
                    </thead>
                    <tbody>
                      {problems.map(problem => (
                        <tr key={problem.problem_id} className="border-b border-gray-100 last:border-0">
                          <th scope="row" className="py-3 pr-4 font-medium text-gray-800">{problem.topic}</th>
                          <td className="py-3 pr-4 text-gray-700">Level {problem.difficulty ?? 'Unrated'}</td>
                          <td className="py-3 pr-4 text-gray-700">{problem.accuracy_percent}%</td>
                          <td className="py-3 text-gray-700">{problem.responses}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function Metric({ label, value, detail }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-medium text-gray-600">{label}</h2>
      <p className="mt-2 text-3xl font-bold tracking-tight text-[#2a61ba]">{value}</p>
      <p className="mt-1 text-xs text-gray-500">{detail}</p>
    </section>
  );
}
