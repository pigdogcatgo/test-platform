export default function ProblemCatalogFilters({
  demoMode,
  filters,
  options,
  onChange,
}) {
  const set = (key, value) => onChange({ ...filters, [key]: value });
  const hasFilters = Object.entries(filters).some(([, value]) => value !== '');

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm" aria-labelledby="catalog-heading">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="catalog-heading" className="text-base font-semibold text-gray-900">
            {demoMode ? 'Fictional OPLET-style practice catalog' : 'Problem bank'}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-gray-600">
            {demoMode
              ? 'Synthetic sample questions and metadata for this prototype. Not affiliated with MATHCOUNTS, OPLET, or any question source.'
              : 'Search the problem bank by question, source, difficulty, or year.'}
          </p>
        </div>
        {hasFilters && (
          <button
            type="button"
            onClick={() => onChange({ search: '', difficulty: '', yearFrom: '', yearTo: '' })}
            className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm font-medium text-[#2a61ba] hover:bg-gray-50 focus-visible:outline"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="sm:col-span-2 lg:col-span-2">
          <label htmlFor="catalog-search" className="mb-1 block text-sm font-medium text-gray-700">Search</label>
          <input
            id="catalog-search"
            type="search"
            value={filters.search}
            onChange={event => set('search', event.target.value)}
            placeholder="Question, source, or folder"
            className="min-h-11 w-full rounded-lg border border-gray-300 px-3 text-sm focus:border-[#2a61ba] focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="catalog-difficulty" className="mb-1 block text-sm font-medium text-gray-700">Difficulty</label>
          <select id="catalog-difficulty" value={filters.difficulty} onChange={event => set('difficulty', event.target.value)} className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-[#2a61ba] focus:outline-none">
            <option value="">All levels</option>
            {options.difficulties.map(level => <option key={level} value={level}>{level}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2 lg:col-span-2">
          <span className="mb-1 block text-sm font-medium text-gray-700">Year range</span>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="catalog-year-from" className="sr-only">From year</label>
              <select id="catalog-year-from" value={filters.yearFrom} onChange={event => set('yearFrom', event.target.value)} className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-[#2a61ba] focus:outline-none">
                <option value="">From any year</option>
                {options.years.map(year => <option key={year} value={year}>{year}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="catalog-year-to" className="sr-only">To year</label>
              <select id="catalog-year-to" value={filters.yearTo} onChange={event => set('yearTo', event.target.value)} className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-[#2a61ba] focus:outline-none">
                <option value="">To any year</option>
                {options.years.map(year => <option key={year} value={year}>{year}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>
      {options.years.length === 0 && !demoMode && (
        <p className="mt-2 text-xs text-gray-600">Year filtering is unavailable because this bank has no year metadata.</p>
      )}
    </section>
  );
}
