import React from 'react';

export function BrandMark() {
  return (
    <div className="brand-lockup" aria-label="MATHCOUNTS Test Admin">
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="brand-name">MATHCOUNTS</span>
    </div>
  );
}

export function AuthLayout({ children }) {
  return (
    <main className="auth-page">
      <div className="auth-shell">
        <section className="auth-brand-panel" aria-labelledby="auth-brand-heading">
          <BrandMark />
          <div className="auth-brand-copy">
            <p className="auth-kicker">Test administration</p>
            <h2 id="auth-brand-heading">Make every practice count.</h2>
            <p>Build focused tests, organize problems, and help students see their progress.</p>
          </div>
          <ul className="auth-benefits" aria-label="Platform features">
            <li><span aria-hidden="true">✓</span> Curate a problem library</li>
            <li><span aria-hidden="true">✓</span> Create Sprint and Target tests</li>
            <li><span aria-hidden="true">✓</span> Track student progress</li>
          </ul>
          <p className="auth-brand-footer">Built for teachers and MATHCOUNTS teams</p>
        </section>
        <section className="auth-content" aria-label="Account access">
          {children}
        </section>
      </div>
      <footer className="auth-page-footer">MATHCOUNTS Test Admin</footer>
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
