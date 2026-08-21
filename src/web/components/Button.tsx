import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The only button in the wizard.
 *
 * `busy` disables it and swaps the label, which is how the "cannot submit twice"
 * requirement is met at the interface level (Issue #1 section 68). The guard
 * that actually matters is in `App.tsx`, which refuses to start a second request
 * while one is in flight - a disabled attribute is a hint to the person, not a
 * lock, and a double tap on a slow phone can land both events before React has
 * re-rendered.
 *
 * `aria-busy` and `aria-disabled` are set alongside `disabled` so a screen
 * reader says the button is working rather than silently doing nothing.
 */

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: 'primary' | 'secondary' | 'quiet';
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  busy = false,
  busyLabel = 'กำลังดำเนินการ...',
  disabled,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={`vra-button vra-button--${variant}`}
      disabled={disabled || busy}
      aria-disabled={disabled || busy ? true : undefined}
      aria-busy={busy ? true : undefined}
    >
      {busy ? busyLabel : children}
    </button>
  );
}
