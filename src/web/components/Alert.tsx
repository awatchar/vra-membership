import type { ReactNode } from 'react';

/**
 * A message the applicant needs to read.
 *
 * `role="alert"` on the error variant so it is announced the moment it appears -
 * an error that only a sighted user notices is not an error message. Information
 * uses `role="status"`, which is announced politely and does not interrupt.
 *
 * The text is always something written for an applicant. Provider and framework
 * messages are converted in `api/client.ts` before they can reach here.
 */

export interface AlertProps {
  tone: 'error' | 'info' | 'success';
  title?: string;
  children: ReactNode;
}

export function Alert({ tone, title, children }: AlertProps) {
  return (
    <div
      className={`vra-alert vra-alert--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      {title ? <p className="vra-alert__title">{title}</p> : null}
      <div className="vra-alert__body">{children}</div>
    </div>
  );
}
