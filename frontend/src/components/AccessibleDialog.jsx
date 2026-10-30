import { useEffect, useRef } from 'react';

const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function AccessibleDialog({
  ariaLabel,
  children,
  onClose,
  panelClassName = '',
  closeOnBackdrop = true,
  closeOnEscape = true,
}) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const escapeRef = useRef(closeOnEscape);
  const backdropRef = useRef(closeOnBackdrop);

  useEffect(() => {
    closeRef.current = onClose;
    escapeRef.current = closeOnEscape;
    backdropRef.current = closeOnBackdrop;
  }, [onClose, closeOnEscape, closeOnBackdrop]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const firstFocusable = dialogRef.current?.querySelector(focusableSelector);
    (firstFocusable || dialogRef.current)?.focus();

    const handleKeyDown = event => {
      if (event.key === 'Escape' && escapeRef.current && closeRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll(focusableSelector) || []);
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
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
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget && backdropRef.current) closeRef.current?.();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`accessible-dialog-panel w-full overflow-y-auto rounded-xl bg-white shadow-xl ${panelClassName}`}
      >
        {children}
      </section>
    </div>
  );
}
