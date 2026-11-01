import { BrandMark } from './AuthLayout';

export function PracticeHeader({ audience, demoMode, onLogout }) {
  return (
    <header className="practice-header">
      <div className="practice-header-inner">
        <BrandMark demoMode={demoMode} />
        <span className="practice-audience">{audience}</span>
        <button type="button" className="practice-signout" onClick={onLogout}>Log out</button>
      </div>
    </header>
  );
}

export function FolioIntro({ title, description, count, countLabel, children }) {
  return (
    <section className="folio-intro" aria-label={title}>
      <div className="folio-copy">
        <p className="folio-label">Your practice space</p>
        <h1>{title}</h1>
        <p className="folio-description">{description}</p>
        {children && <div className="folio-actions">{children}</div>}
      </div>
      <div className="folio-ledger">
        <span className="folio-count">{String(count).padStart(2, '0')}</span>
        <span>{countLabel}</span>
      </div>
    </section>
  );
}
