import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

/**
 * A labelled text input.
 *
 * Every input in the wizard goes through here, which is what makes "every field
 * has a label" a property of the code rather than a habit (Issue #1 section 68).
 * The label is a real `<label for>`, so tapping it focuses the field - on a
 * phone that is the difference between a usable form and a fiddly one.
 *
 * An error is wired with `aria-describedby` and `aria-invalid` and announced
 * with `role="alert"`, so a screen reader reports it when it appears rather than
 * only when the field is next focused. `required` is marked visually *and* with
 * the attribute; a red asterisk alone is invisible to a screen reader and to
 * anyone who cannot distinguish the colour.
 */

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Shown under the label, for anything the applicant needs to know first. */
  hint?: ReactNode;
  error?: string | undefined;
}

export function Field({ label, hint, error, required, ...input }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="vra-field">
      <label className="vra-field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="vra-field__required">
            {' '}
            <span aria-hidden="true">*</span>
            <span className="vra-visually-hidden">(จำเป็น)</span>
          </span>
        ) : null}
      </label>

      {hint ? (
        <p className="vra-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}

      <input
        {...input}
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={described.length > 0 ? described : undefined}
        className={error ? 'vra-input vra-input--error' : 'vra-input'}
      />

      {error ? (
        <p className="vra-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
