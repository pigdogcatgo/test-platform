import React from 'react';

export function BrandMark({ demoMode = false }) {
  return (
    <div className="brand-lockup" aria-label={demoMode ? 'Practice Platform Prototype' : 'MATHCOUNTS Test Admin'}>
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="brand-name">{demoMode ? 'Practice Platform' : 'MATHCOUNTS'}</span>
    </div>
  );
}

export function AuthLayout({ children, demoMode = false }) {
  return (
    <main className="auth-page">
      <div className="auth-shell">
        <section className="auth-brand-panel" aria-labelledby="auth-brand-heading">
          <BrandMark demoMode={demoMode} />
          <div className="auth-brand-copy">
            <p className="auth-kicker">{demoMode ? 'Practice platform prototype' : 'Test administration'}</p>
            <h2 id="auth-brand-heading">{demoMode ? 'A prototype for focused practice.' : 'Make every practice count.'}</h2>
            <p>Build focused tests, organize problems, and help students see their progress.</p>
          </div>
          <div className="auth-construction" aria-hidden="true">
            <svg viewBox="0 0 300 160" fill="none"><path d="M24 136H276M48 152V16" stroke="currentColor" opacity=".25" /><path d="M48 136L232 136L184 32Z" stroke="currentColor" strokeWidth="2" /><path d="M184 32V136" stroke="currentColor" strokeDasharray="4 6" opacity=".5" /><circle cx="48" cy="136" r="4" fill="currentColor"/><circle cx="232" cy="136" r="4" fill="currentColor"/><circle cx="184" cy="32" r="4" fill="currentColor"/><path d="M174 136V126H184" stroke="currentColor" /></svg>
          </div>
          <ul className="auth-benefits" aria-label="Platform features">
            <li><span aria-hidden="true">✓</span> Curate a problem library</li>
            <li><span aria-hidden="true">✓</span> Create Sprint and Target tests</li>
            <li><span aria-hidden="true">✓</span> Track student progress</li>
          </ul>
          <p className="auth-brand-footer">{demoMode ? 'Independent fictional preview' : 'Built for teachers and MATHCOUNTS teams'}</p>
        </section>
        <section className="auth-content" aria-label="Account access">
          {children}
        </section>
      </div>
      <footer className="auth-page-footer">{demoMode ? 'Practice Platform Prototype' : 'MATHCOUNTS Test Admin'}</footer>
    </main>
  );
}

export function PasswordField({ id, label = 'Password', value, onChange, autoComplete, visible, onToggle, hint, required = true, minLength }) {
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <div className="password-wrapper">
        <input
          id={id}
          name={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className="toggle-password"
          onClick={onToggle}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint && <p id={`${id}-hint`} className="auth-field-hint">{hint}</p>}
    </div>
  );
}
