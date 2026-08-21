import { useId, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * Choosing an image from the camera or the photo library.
 *
 * A styled `<label for>` wrapping a real `<input type="file">` rather than a
 * button that calls `click()` on a hidden input: the label is keyboard
 * reachable, announces itself correctly, and works when scripting is partly
 * broken. A `<button>` driving a hidden input has to reimplement all three.
 *
 * **There is deliberately no `capture` attribute.** An earlier version set it,
 * on the belief that it merely hints at the rear camera. On Android Chrome it
 * does not hint: it opens the camera and removes the album and file options
 * altogether. That broke the step it mattered most on - a payment slip is
 * usually already a screenshot in the album, so an applicant on Android could
 * not submit one at all. Without the attribute the operating system offers the
 * camera, the album and the files, and the applicant picks.
 */

export interface ImagePickerProps {
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
  onSelect: (file: File) => void;
  error?: string | undefined;
}

export function ImagePicker({ label, hint, disabled, onSelect, error }: ImagePickerProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="vra-picker">
      <label className="vra-picker__label" htmlFor={id}>
        {label}
      </label>
      {hint ? <p className="vra-field__hint">{hint}</p> : null}

      <input
        ref={inputRef}
        id={id}
        className="vra-picker__input"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // The value is cleared so choosing the same file twice fires `change`
          // again - otherwise a retry after a failed OCR looks like nothing
          // happened.
          event.target.value = '';
          if (file) onSelect(file);
        }}
      />

      {error ? (
        <p className="vra-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
