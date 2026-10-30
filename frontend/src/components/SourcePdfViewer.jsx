import { useState } from 'react';

const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 25;

function pageForProblem(problem) {
  const page = Number(problem?.pageNumber ?? problem?.sourcePage ?? problem?.page);
  return Number.isInteger(page) && page > 0 ? page : null;
}

/**
 * Displays a caller-authorized PDF Blob URL in the browser's built-in PDF viewer.
 *
 * Props:
 * - pdfUrl: object URL created from an authenticated PDF response; caller owns/revokes it
 * - pageNumber: controlled 1-based current page
 * - onPageChange(page): optional page control callback
 * - problems: ordered { id, pageNumber } locators
 * - activeProblemId: currently selected problem ID
 * - onSelectProblem(id): optional callback for the question navigator
 */
export default function SourcePdfViewer({
  pdfUrl,
  pageNumber = 1,
  onPageChange,
  problems = [],
  activeProblemId,
  onSelectProblem,
  className = '',
}) {
  const [localPage, setLocalPage] = useState(pageNumber);
  const [zoom, setZoom] = useState(100);
  const currentPage = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : localPage;

  const setPage = (rawValue) => {
    const parsed = Number.parseInt(String(rawValue), 10);
    if (!Number.isInteger(parsed) || parsed < 1) return;
    setLocalPage(parsed);
    onPageChange?.(parsed);
  };

  const iframeSource = pdfUrl ? `${pdfUrl}#page=${currentPage}&zoom=${zoom}` : undefined;

  return (
    <section className={`flex min-h-[28rem] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm ${className}`} aria-label="Source PDF">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-3 py-2">
        <div className="flex items-center gap-2" aria-label="PDF page controls">
          <button
            type="button"
            onClick={() => setPage(currentPage - 1)}
            disabled={currentPage <= 1 || !pdfUrl}
            className="min-h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Previous PDF page"
          >
            Previous
          </button>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <span className="sr-only">PDF page number</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              value={currentPage}
              onChange={(event) => setPage(event.target.value)}
              disabled={!pdfUrl}
              className="min-h-10 w-16 rounded-lg border border-gray-300 bg-white px-2 text-center"
              aria-label="PDF page number"
            />
            <span>page</span>
          </label>
          <button
            type="button"
            onClick={() => setPage(currentPage + 1)}
            disabled={!pdfUrl}
            className="min-h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Next PDF page"
          >
            Next
          </button>
        </div>
        <div className="flex items-center gap-2" aria-label="PDF zoom controls">
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))}
            disabled={zoom <= MIN_ZOOM || !pdfUrl}
            className="min-h-10 min-w-10 rounded-lg border border-gray-300 bg-white text-lg font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="min-w-14 text-center text-sm text-gray-700" aria-live="polite">{zoom}%</span>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))}
            disabled={zoom >= MAX_ZOOM || !pdfUrl}
            className="min-h-10 min-w-10 rounded-lg border border-gray-300 bg-white text-lg font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      {problems.length > 0 && (
        <nav className="flex gap-2 overflow-x-auto border-b border-gray-200 px-3 py-2" aria-label="Questions in PDF">
          {problems.map((problem, index) => {
            const page = pageForProblem(problem);
            const selected = String(problem.id) === String(activeProblemId);
            return (
              <button
                key={problem.id}
                type="button"
                onClick={() => {
                  if (page) setPage(page);
                  onSelectProblem?.(problem.id);
                }}
                disabled={!pdfUrl}
                aria-current={selected ? 'page' : undefined}
                title={page ? `Question ${index + 1}, page ${page}` : `Question ${index + 1}`}
                className={`min-h-10 min-w-10 rounded-lg border px-3 text-sm font-semibold disabled:opacity-50 ${selected ? 'border-[#006da6] bg-[#006da6] text-white' : 'border-gray-300 bg-white text-gray-700 hover:border-[#006da6] hover:bg-blue-50'}`}
              >
                {index + 1}
              </button>
            );
          })}
        </nav>
      )}

      <div className="relative min-h-[24rem] flex-1 bg-gray-100">
        {pdfUrl ? (
          <iframe
            key={iframeSource}
            src={iframeSource}
            title="Test source PDF"
            className="absolute inset-0 h-full min-h-[24rem] w-full border-0 bg-white"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <p className="max-w-sm text-sm text-gray-600" role="status">Loading the source PDF…</p>
          </div>
        )}
      </div>
    </section>
  );
}
