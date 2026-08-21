import { useEffect, useRef } from 'react';
import { renderTurnstile } from '../lib/turnstile';
import type { TurnstileWidget } from '../lib/turnstile';

/**
 * Renders the Turnstile widget for one step.
 *
 * Nothing is rendered when there is no site key. That happens in local
 * development and in CI, and it is safe because the browser is not what decides:
 * the Worker accepts any token under `PROVIDER_MODE=mock` and requires a real one
 * under `live`. A client that sends nothing cannot talk its way past the server.
 *
 * `resetKey` forces a fresh challenge. A token is single-use, so after a failed
 * submit the next attempt needs a new one - reusing the old token would be
 * rejected and look to the applicant like the same error twice.
 */

export interface TurnstileGateProps {
  siteKey: string | null;
  action: string;
  resetKey: number;
  onToken: (token: string | null) => void;
}

export function TurnstileGate({ siteKey, action, resetKey, onToken }: TurnstileGateProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TurnstileWidget | null>(null);

  // The callback is kept in a ref so a new function identity from the parent
  // does not tear down and re-render the widget, which would throw away a token
  // the applicant has already solved for. Written in an effect rather than
  // during render, which React forbids.
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!siteKey) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    void renderTurnstile({
      container,
      siteKey,
      action,
      onToken: (token) => {
        if (!cancelled) onTokenRef.current(token);
      },
    }).then((widget) => {
      if (cancelled) {
        widget?.remove();
        return;
      }
      widgetRef.current = widget;
    });

    return () => {
      cancelled = true;
      widgetRef.current?.remove();
      widgetRef.current = null;
    };
  }, [siteKey, action, resetKey]);

  if (!siteKey) return null;

  return (
    <div className="vra-turnstile">
      <div ref={containerRef} />
      <p className="vra-field__hint">ระบบตรวจสอบว่าคำขอนี้มาจากผู้ใช้จริง</p>
    </div>
  );
}
