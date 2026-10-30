import { useCallback, useMemo, useState } from 'react';
import ConfirmationDialog from './ConfirmationDialog';
import LatexRenderer from './LatexRenderer';
import ProblemImage from './ProblemImage';
import SourcePdfViewer from './SourcePdfViewer';

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function StudentTestPage({
  activeTest,
  timeRemaining,
  testProblems,
  testAnswers,
  setTestAnswers,
  token,
  pdfUrl,
  onSubmit,
  submitting,
  submissionError,
  onOpenReview,
}) {
  const [showSubmitConfirmation, setShowSubmitConfirmation] = useState(false);
  const [activeProblemId, setActiveProblemId] = useState(testProblems[0]?.id ?? null);
  const [viewerPage, setViewerPage] = useState(() => {
    const page = Number(testProblems[0]?.pdfPage ?? testProblems[0]?.source_page ?? testProblems[0]?.sourcePage);
    return Number.isInteger(page) && page > 0 ? page : 1;
  });
  const [mobilePanel, setMobilePanel] = useState('answers');
  const pdfBacked = Boolean(pdfUrl);
  const activeProblem = useMemo(
    () => testProblems.find(problem => String(problem.id) === String(activeProblemId)) || testProblems[0],
    [testProblems, activeProblemId]
  );
  const answeredQuestions = testProblems
    .map((problem, index) => ({ id: problem.id, number: index + 1, answer: testAnswers[problem.id] || '' }))
    .filter(item => item.answer.trim());
  const unansweredQuestions = testProblems
    .map((problem, index) => ({ id: problem.id, number: index + 1, answer: testAnswers[problem.id] || '' }))
    .filter(item => !item.answer.trim());
  const answeredCount = answeredQuestions.length;
  const unansweredCount = unansweredQuestions.length;
  const progress = testProblems.length ? (answeredCount / testProblems.length) * 100 : 0;
  const closeReview = useCallback(() => setShowSubmitConfirmation(false), []);

  const selectProblem = (problemId, focusAnswer = true) => {
    setActiveProblemId(problemId);
    const problem = testProblems.find(item => String(item.id) === String(problemId));
    const page = Number(problem?.pdfPage ?? problem?.source_page ?? problem?.sourcePage);
    if (Number.isInteger(page) && page > 0) setViewerPage(page);
    if (focusAnswer) {
      window.setTimeout(() => document.getElementById(`answer-${problemId}`)?.focus({ preventScroll: true }), 0);
    }
  };

  return (
    <main className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-4xl p-3 sm:p-6">
        <header className="sticky top-0 z-50 mb-6">
          <div className="bg-white rounded-xl shadow px-4 sm:px-6 py-4 flex items-center gap-3">
            <h1 className="text-base sm:text-xl font-semibold text-gray-800 text-left flex-1 min-w-0 break-words">{activeTest.name}</h1>
            <div className="flex justify-end shrink-0">
              <div
                role="timer"
                aria-label={`Time remaining ${formatTime(timeRemaining)}`}
                className={`px-4 py-2 rounded-lg font-semibold text-sm ${timeRemaining < 60 ? 'bg-red-100 text-red-700' : 'bg-[#e8f4f9] text-[#006da6]'}`}
              >
                {formatTime(timeRemaining)}
              </div>
            </div>
          </div>
        </header>

        <section className="mb-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm" aria-label="Test progress" aria-live="polite">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <p className="font-semibold text-gray-800">{answeredCount} of {testProblems.length} answered</p>
            <p className="text-gray-600">{unansweredCount} unanswered</p>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-label="Questions answered" aria-valuemin="0" aria-valuemax={testProblems.length} aria-valuenow={answeredCount}>
            <div className="h-full rounded-full bg-[#006da6] transition-[width] duration-200" style={{ width: `${progress}%` }} />
          </div>
        </section>

        <nav className="mb-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm" aria-label="Question navigation">
          <h2 className="mb-3 text-sm font-semibold text-gray-800">Jump to a question</h2>
          <ol className="grid grid-cols-6 gap-2 sm:grid-cols-10 lg:grid-cols-15">
            {testProblems.map((problem, index) => {
              const answered = Boolean((testAnswers[problem.id] || '').trim());
              return (
                <li key={problem.id}>
                  <button
                    type="button"
                    aria-label={`Question ${index + 1}, ${answered ? 'answered' : 'unanswered'}`}
                    title={`Question ${index + 1}: ${answered ? 'answered' : 'unanswered'}`}
                    onClick={() => {
                      if (pdfBacked) selectProblem(problem.id, false);
                      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                      document.getElementById(`question-${problem.id}`)?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
                      document.getElementById(`answer-${problem.id}`)?.focus({ preventScroll: true });
                    }}
                    className={`min-h-11 w-full rounded-lg border px-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#007bb8] ${answered ? 'border-[#006da6] bg-[#006da6] text-white hover:bg-[#006699]' : 'border-gray-300 bg-white text-gray-700 hover:border-[#006da6] hover:bg-blue-50'}`}
                  >
                    {index + 1}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs text-gray-600">Blue questions have an answer; outlined questions are blank.</p>
        </nav>

        {pdfBacked && (
          <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-gray-200 p-1 lg:hidden" role="tablist" aria-label="Test content">
            <button type="button" role="tab" aria-selected={mobilePanel === 'pdf'} onClick={() => setMobilePanel('pdf')} className={`min-h-11 rounded-lg px-3 text-sm font-semibold ${mobilePanel === 'pdf' ? 'bg-white text-[#006da6] shadow-sm' : 'text-gray-700'}`}>PDF</button>
            <button type="button" role="tab" aria-selected={mobilePanel === 'answers'} onClick={() => setMobilePanel('answers')} className={`min-h-11 rounded-lg px-3 text-sm font-semibold ${mobilePanel === 'answers' ? 'bg-white text-[#006da6] shadow-sm' : 'text-gray-700'}`}>Answers</button>
          </div>
        )}

        <section className="mb-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 space-y-2" aria-labelledby="answer-format-heading">
          <h2 id="answer-format-heading" className="font-semibold">How to format answers</h2>
          <ul className="list-disc list-inside space-y-1 ml-1">
            <li>Numbers: <code className="bg-gray-200 px-1 rounded">42</code></li>
            <li>Fractions: <code className="bg-gray-200 px-1 rounded">3/4</code> (not LaTeX)</li>
            <li>Radicals: <code className="bg-gray-200 px-1 rounded">√2</code>, <code className="bg-gray-200 px-1 rounded">√2/2</code>, <code className="bg-gray-200 px-1 rounded">2√3</code></li>
            <li>Ordered pairs: <code className="bg-gray-200 px-1 rounded">(-1,-3)</code> or <code className="bg-gray-200 px-1 rounded">(1/2,-3/4)</code></li>
          </ul>
          <p><strong>Do not use LaTeX</strong> (e.g. <code className="bg-gray-200 px-1 rounded">\frac{'{'}3{'}'}{'{'}4{'}'}</code>) — it will not be graded correctly. Use plain format above. Questions use LaTeX for display; your answers use simple text.</p>
        </section>

        <div className="mb-4 rounded-xl border-2 border-amber-500 bg-amber-100 px-4 py-4 text-center text-sm sm:text-base font-semibold text-amber-900 shadow-sm" role="note">
          Keep this page open and in the foreground. Switching tabs automatically submits your answers when you return. Reloading or closing the page can also submit them.
        </div>

        {timeRemaining < 60 && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-6 py-4 text-center text-sm text-red-700" role="status">
            Less than 1 minute remaining. Please submit soon.
          </div>
        )}

        <div className={pdfBacked ? 'grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]' : ''}>
          {pdfBacked && (
            <div className={`${mobilePanel === 'pdf' ? 'block' : 'hidden'} lg:sticky lg:top-24 lg:block`}>
              <SourcePdfViewer
                pdfUrl={pdfUrl}
                pageNumber={viewerPage}
                onPageChange={setViewerPage}
                problems={testProblems.map((problem, index) => ({
                  id: problem.id,
                  pageNumber: problem.pdfPage ?? problem.source_page ?? problem.sourcePage,
                  number: index + 1,
                }))}
                activeProblemId={activeProblem?.id}
                onSelectProblem={problemId => selectProblem(problemId)}
                className="h-[70vh] min-h-[28rem] lg:h-[calc(100vh-8rem)]"
              />
            </div>
          )}
          <div className={`${pdfBacked ? `${mobilePanel === 'answers' ? 'block' : 'hidden'} lg:block ` : ''}space-y-4`}>
            {testProblems.map((problem, index) => (
              <section key={problem.id} id={`question-${problem.id}`} className={`scroll-mt-28 rounded-xl bg-white p-4 shadow sm:p-6 ${pdfBacked && String(activeProblem?.id) === String(problem.id) ? 'ring-2 ring-[#006da6]' : ''}`} aria-labelledby={`question-heading-${problem.id}`}>
                <div className="mb-4">
                  <span className="text-xs font-medium text-gray-500">Question {index + 1} of {testProblems.length}</span>
                  {!pdfBacked && problem.source && <p className="text-xs text-gray-500 mt-0.5">Source: {problem.source}</p>}
                  {!pdfBacked && <h2 id={`question-heading-${problem.id}`} className="text-base font-semibold text-gray-800 mt-1"><LatexRenderer text={problem.question} /></h2>}
                  {!pdfBacked && problem.image_url && <ProblemImage url={problem.image_url} token={token} />}
                  {pdfBacked && Number(problem.pdfPage ?? problem.source_page ?? problem.sourcePage) > 0 && <p className="text-xs text-gray-500 mt-1">Source PDF page {problem.pdfPage ?? problem.source_page ?? problem.sourcePage}</p>}
                  {pdfBacked && problem.question && (
                    <details className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                      <summary className="cursor-pointer text-sm font-medium text-[#006da6]">Read question text</summary>
                      <div className="mt-2 text-sm leading-6 text-gray-800"><LatexRenderer text={problem.question} /></div>
                    </details>
                  )}
                </div>
                <label htmlFor={`answer-${problem.id}`} className="sr-only">Answer for question {index + 1}</label>
                <input
                  id={`answer-${problem.id}`}
                  type="text"
                  value={testAnswers[problem.id] || ''}
                  onFocus={() => { if (pdfBacked) selectProblem(problem.id, false); }}
                  onChange={event => setTestAnswers({ ...testAnswers, [problem.id]: event.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-4 py-3 text-center text-base focus:border-[#006da6] focus:outline-none sm:text-sm"
                  placeholder="e.g. 42, 3/4, √2, √2/2"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck="false"
                />
                {(testAnswers[problem.id] || '').trim() && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-gray-500">
                    <span>Will be interpreted as:</span>
                    <code className="rounded border border-gray-200 bg-[#f5f7f8] px-2 py-1 font-mono text-gray-800">{String(testAnswers[problem.id]).trim()}</code>
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <button type="button" onClick={() => { onOpenReview(); setShowSubmitConfirmation(true); }} disabled={submitting} className="w-full bg-[#006da6] hover:bg-[#006699] disabled:opacity-60 text-white py-3 rounded-lg font-semibold">
            Review and submit test
          </button>
          {submissionError && !showSubmitConfirmation && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{submissionError} Reopen the review to retry.</p>}
        </div>
      </div>

      {showSubmitConfirmation && (
        <ConfirmationDialog
          title="Submit this test?"
          description={`You answered ${answeredCount} of ${testProblems.length} questions. ${unansweredCount > 0 ? `${unansweredCount} ${unansweredCount === 1 ? 'question is' : 'questions are'} blank.` : 'Every question has an answer.'} Your answers cannot be changed after submission.`}
          confirmLabel="Submit final answers"
          busyLabel="Submitting…"
          busy={submitting}
          error={submissionError}
          reviewItems={unansweredQuestions}
          onReviewItem={questionId => {
            closeReview();
            window.setTimeout(() => {
              const answerField = document.getElementById(`answer-${questionId}`);
              answerField?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              answerField?.focus({ preventScroll: true });
            }, 0);
          }}
          onConfirm={onSubmit}
          onCancel={closeReview}
        />
      )}
    </main>
  );
}
