import { useEffect, useRef } from 'react';

export default function ConfirmationDialog({ title, description, confirmLabel, busyLabel, busy = false, error, reviewItems = [], onReviewItem, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  const busyRef = useRef(busy);

  useEffect(() => {
    const previousFocus = document.activeElement;
    confirmRef.current?.focus();
    const handleKeyDown = event => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onCancel();
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || []);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [onCancel]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
    else confirmRef.current?.focus();
  }, [busy]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby="submit-confirmation-title"
        aria-describedby="submit-confirmation-copy"
        className="confirmation-dialog-panel w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
      >
        <h2 id="submit-confirmation-title" className="text-xl font-semibold text-gray-900">{title}</h2>
        <p id="submit-confirmation-copy" className="mt-3 text-sm leading-6 text-gray-600">{description}</p>
        {reviewItems.length > 0 && (
          <div className="mt-4">
            <p className="text-sm font-semibold text-gray-800">Review blank answers</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {reviewItems.map(item => (
                <button key={item.id} type="button" onClick={() => onReviewItem(item.id)} disabled={busy} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-[#006da6] hover:bg-blue-50 disabled:cursor-wait disabled:opacity-60">Question {item.number}</button>
              ))}
            </div>
          </div>
        )}
        {error && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>}
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60">Keep working</button>
          <button ref={confirmRef} type="button" onClick={onConfirm} disabled={busy} className="rounded-lg bg-[#006da6] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#006699] disabled:opacity-60">{busy ? busyLabel : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
