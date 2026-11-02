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
            {demoMode ? 'Fictional OPLET-style practice catalog' : 'Search problems'}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-gray-600">
            {demoMode
              ? 'Synthetic sample questions and metadata for this prototype. Not affiliated with MATHCOUNTS, OPLET, or any question source.'
              : 'Search by problem text, year, level, round, or Elo.'}
          </p>
        </div>
        {hasFilters && (
          <button
            type="button"
            onClick={() => onChange({ search: '', year: '', level: '', round: '' })}
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
            placeholder="Problem text, year, level, round, or Elo"
            className="min-h-11 w-full rounded-lg border border-gray-300 px-3 text-sm focus:border-[#2a61ba] focus:outline-none"
          />
        </div>
        {[
          ['year', 'Year', options.years],
          ['level', 'Level', options.levels],
          ['round', 'Round', options.rounds],
        ].map(([key, label, values]) => (
          <div key={key}>
            <label htmlFor={`catalog-${key}`} className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
            <select id={`catalog-${key}`} value={filters[key]} onChange={event => set(key, event.target.value)} className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-[#2a61ba] focus:outline-none">
              <option value="">All {label.toLowerCase()}s</option>
              {values.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}
