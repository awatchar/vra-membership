/**
 * Turnstile widget loading.
 *
 * The site key is public and the secret stays on the server, so nothing here is
 * confidential - but this is still the only third-party script the page loads,
 * so it is loaded lazily and only once, on the two steps that need it.
 *
 * When no site key is configured - local development, and CI - the widget is
 * skipped and the token is null. That is safe because the decision belongs to
 * the server: `PROVIDER_MODE=mock` accepts any token, and `live` requires the
 * secret and rejects a missing one. The browser cannot talk its way past it.
 */

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      theme?: 'auto' | 'light' | 'dark';
      language?: string;
      action?: string;
    },
  ): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

function turnstile(): TurnstileApi | null {
  const candidate = (globalThis as { turnstile?: unknown }).turnstile;
  return candidate ? (candidate as TurnstileApi) : null;
}

let loading: Promise<TurnstileApi | null> | null = null;

/** Loads the script once per page and resolves with the API, or null if it fails. */
export function loadTurnstile(): Promise<TurnstileApi | null> {
  const existing = turnstile();
  if (existing) return Promise.resolve(existing);
  if (loading) return loading;

  loading = new Promise<TurnstileApi | null>((resolve) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(turnstile());
    // A blocked or failed script must not deadlock the wizard: it resolves null,
    // the widget is skipped, and the server decides what to do with no token.
    script.onerror = () => resolve(null);
    document.head.append(script);
  });

  return loading;
}

export interface TurnstileWidget {
  reset(): void;
  remove(): void;
}

export interface RenderOptions {
  container: HTMLElement;
  siteKey: string;
  onToken: (token: string | null) => void;
  action?: string;
}

/** Renders a widget and reports its token, or null when it expires or errors. */
export async function renderTurnstile(options: RenderOptions): Promise<TurnstileWidget | null> {
  const api = await loadTurnstile();
  if (!api) return null;

  const id = api.render(options.container, {
    sitekey: options.siteKey,
    callback: (token) => options.onToken(token),
    'expired-callback': () => options.onToken(null),
    'error-callback': () => options.onToken(null),
    theme: 'auto',
    language: 'th',
    ...(options.action ? { action: options.action } : {}),
  });

  return {
    reset: () => api.reset(id),
    remove: () => api.remove(id),
  };
}
