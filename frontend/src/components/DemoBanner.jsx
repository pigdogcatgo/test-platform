export default function DemoBanner() {
  if (import.meta.env.VITE_DEMO_MODE !== 'true') return null;

  return (
    <aside className="mx-auto w-full max-w-7xl px-3 pt-3 sm:px-6" role="note" aria-label="Shared fictional demo notice">
      <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-5 text-sky-950">
        <strong>Shared demo · fictional data only.</strong>{' '}
        Use the fictional teacher or student demo account. Do not enter real student, school, or confidential information. Demo activity is shared and persistent; if someone has already taken a test, ask the teacher account to create a fresh assignment. This prototype is not affiliated with MATHCOUNTS or OPLET.
      </div>
    </aside>
  );
}
