import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/web/App';

/**
 * The wizard driven the way an applicant drives it.
 *
 * `fetch` is stubbed per test, so nothing reaches a real endpoint and each test
 * decides what the API says. The route it takes here is the manual-entry path:
 * it avoids depending on a rasteriser jsdom does not have, and it is the path a
 * real applicant with a worn card ends up on anyway.
 *
 * All data is synthetic. The citizen ID is a sequential pattern with a correct
 * check digit and cannot belong to anyone.
 */

const VALID_ID = '1234567890121';

interface StubRoute {
  status?: number;
  body?: unknown;
  /** Resolves only when released, to hold a request in flight. */
  hold?: boolean;
}

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

let calls: Recorded[] = [];
let routes: Record<string, StubRoute>;
let release: (() => void) | null = null;

function stubFetch(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = Object.keys(routes).find((candidate) => url.startsWith(candidate));
    const route = key ? routes[key]! : undefined;

    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body ?? null,
    });

    if (!route) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'ไม่พบ' } }), {
        status: 404,
      });
    }

    if (route.hold) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }

    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const CREATED = {
  application: { id: 'application-1', status: 'DRAFT' },
  accessToken: 'a'.repeat(64),
  hasPreviousApplication: false,
};

beforeEach(() => {
  calls = [];
  release = null;
  routes = {
    '/api/config': { body: { turnstileSiteKey: null, environment: 'development' } },
    '/api/applications/application-1': { body: { application: CREATED.application } },
    '/api/applications': { body: CREATED, status: 201 },
  };
  stubFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Accepts the notice and chooses to type the fields rather than photograph. */
async function reachIdentity(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'เริ่มสมัครสมาชิก' }));
  await user.click(screen.getByRole('button', { name: 'กรอกข้อมูลเองแทน' }));
  await waitFor(() => expect(screen.getByLabelText(/เลขบัตรประชาชน/)).toBeInTheDocument());
}

async function fillIdentity(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/เลขบัตรประชาชน/), VALID_ID);
  await user.type(screen.getByLabelText(/ชื่อ \(ภาษาไทย\)/), 'ทดสอบ');
  await user.type(screen.getByLabelText(/นามสกุล \(ภาษาไทย\)/), 'ระบบสมัคร');
}

describe('the privacy notice', () => {
  it('is the first thing shown, and gates the wizard', () => {
    render(<App />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ก่อนเริ่มสมัคร');
    // Unticked, and the button disabled: a pre-ticked box is not a decision.
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'เริ่มสมัครสมาชิก' })).toBeDisabled();
  });

  it('says the card image is not kept and the photo is a choice', () => {
    render(<App />);

    expect(screen.getByText(/ระบบไม่เก็บภาพบัตร/)).toBeInTheDocument();
    expect(screen.getByText(/ระบบจะไม่ใช้ภาพจากบัตรโดยที่ท่านไม่ได้เลือก/)).toBeInTheDocument();
  });

  it('enables the button once accepted', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('checkbox'));

    expect(screen.getByRole('button', { name: 'เริ่มสมัครสมาชิก' })).toBeEnabled();
  });
});

describe('the card step', () => {
  it('offers manual entry before anything has failed', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'เริ่มสมัครสมาชิก' }));

    // OCR on a photographed card fails often enough that hiding the alternative
    // until it does would strand people on step two.
    expect(screen.getByRole('button', { name: 'กรอกข้อมูลเองแทน' })).toBeEnabled();
  });
});

describe('validation', () => {
  it('reports each missing field in Thai without calling the API', async () => {
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);

    await user.click(screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' }));

    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((alert) => alert.textContent?.includes('กรุณากรอกชื่อ'))).toBe(true);
    expect(calls.some((call) => call.url === '/api/applications')).toBe(false);
  });

  it('marks the field invalid and links the message to it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);
    await user.type(screen.getByLabelText(/เลขบัตรประชาชน/), '123');

    await user.click(screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' }));

    const input = screen.getByLabelText(/เลขบัตรประชาชน/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy.length).toBeGreaterThan(0);
  });

  it('formats the citizen ID into the groups printed on the card', async () => {
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);

    await user.type(screen.getByLabelText(/เลขบัตรประชาชน/), VALID_ID);

    expect(screen.getByLabelText(/เลขบัตรประชาชน/)).toHaveValue('1-2345-67890-12-1');
  });
});

describe('creating the application', () => {
  it('sends the digits, not the formatted value', async () => {
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);
    await fillIdentity(user);

    await user.click(screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.url === '/api/applications');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call!.body)) as { citizenId: string }).toMatchObject({
        citizenId: VALID_ID,
      });
    });
  });

  it('carries the capability token on the next request', async () => {
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);
    await fillIdentity(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' }));

    await waitFor(() => expect(screen.getByLabelText(/อีเมล/)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/อีเมล/), 'member@example.test');
    await user.type(screen.getByLabelText(/หมายเลขโทรศัพท์/), '0812345678');
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));

    await waitFor(() => {
      const patch = calls.find((entry) => entry.method === 'PATCH');
      expect(patch?.headers.get('x-vra-application-token')).toBe(CREATED.accessToken);
    });
  });

  it('shows the API message when the API refuses', async () => {
    routes['/api/applications'] = {
      status: 429,
      body: { error: { code: 'RATE_LIMITED', message: 'มีการสมัครถี่เกินไป กรุณารอสักครู่' } },
    };
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);
    await fillIdentity(user);

    await user.click(screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' }));

    await waitFor(() => {
      expect(screen.getByText('มีการสมัครถี่เกินไป กรุณารอสักครู่')).toBeInTheDocument();
    });
  });

  it('shows a Thai message, not a browser one, when the network fails', async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('/api/config')) {
        return Promise.resolve(
          new Response(JSON.stringify({ turnstileSiteKey: null, environment: 'development' })),
        );
      }
      // A rejected fetch, which is what a transport failure looks like.
      return Promise.reject(new TypeError('Failed to fetch'));
    });

    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);
    await fillIdentity(user);

    await user.click(screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' }));

    await waitFor(() => {
      // The browser's own string would be in the browser's language and mean
      // nothing to the applicant.
      expect(screen.getByText(/ไม่สามารถติดต่อระบบได้/)).toBeInTheDocument();
      expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    });
  });
});

describe('pressing submit twice', () => {
  it('creates one application, not two', async () => {
    routes['/api/applications'] = { body: CREATED, status: 201, hold: true };
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);
    await fillIdentity(user);

    // Three clicks dispatched synchronously, with no await between them.
    //
    // Being precise about what this does and does not show: it asserts the
    // outcome - three presses produce one request - but not which of the two
    // mechanisms produced it. React flushes `setBusy(true)` at the end of the
    // first event, so the button is already disabled when the second click
    // arrives, and removing the `inFlight` lock does not make this test fail.
    // The lock is defence for the case this environment cannot reproduce: two
    // pointer events delivered before React has rendered. Claiming the test
    // proves the lock would be claiming more than it does.
    const submit = screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);

    release?.();

    await waitFor(() => expect(screen.getByLabelText(/อีเมล/)).toBeInTheDocument());
    expect(calls.filter((entry) => entry.url === '/api/applications')).toHaveLength(1);
  });

  it('shows the button as busy while the request is open', async () => {
    routes['/api/applications'] = { body: CREATED, status: 201, hold: true };
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);
    await fillIdentity(user);

    await user.click(screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' }));

    const busy = await screen.findByRole('button', { name: 'กำลังบันทึก...' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');

    release?.();
  });
});

describe('going back', () => {
  it('keeps what was already typed', async () => {
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);
    await fillIdentity(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' }));

    await waitFor(() => expect(screen.getByLabelText(/อีเมล/)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/อีเมล/), 'member@example.test');
    await user.type(screen.getByLabelText(/หมายเลขโทรศัพท์/), '0812345678');
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));

    await waitFor(() => expect(screen.getByLabelText(/^ที่อยู่ตามบัตร/)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/^ที่อยู่ตามบัตร/), '99/9 หมู่ 9');
    await user.click(screen.getByRole('button', { name: 'ย้อนกลับ' }));

    // Back to contact, with the answers still there.
    expect(screen.getByLabelText(/อีเมล/)).toHaveValue('member@example.test');

    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await waitFor(() =>
      expect(screen.getByLabelText(/^ที่อยู่ตามบัตร/)).toHaveValue('99/9 หมู่ 9'),
    );
  });
});

describe('client-side storage', () => {
  it('writes nothing at all', async () => {
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);
    await fillIdentity(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' }));
    await waitFor(() => expect(screen.getByLabelText(/อีเมล/)).toBeInTheDocument());

    // The wizard holds a citizen ID and a capability token. Storage outlives the
    // tab and is readable by any script that ever runs on the origin, so nothing
    // goes in it - not the form, not the token.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps the citizen ID and the token out of storage even after a failure', async () => {
    routes['/api/applications'] = {
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดภายในระบบ' } },
    };
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);
    await fillIdentity(user);
    await user.click(screen.getByRole('button', { name: 'ยืนยันข้อมูลนี้' }));

    await waitFor(() => expect(screen.getByText('เกิดข้อผิดพลาดภายในระบบ')).toBeInTheDocument());
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump).not.toContain(VALID_ID);
    expect(dump).not.toContain(CREATED.accessToken);
  });
});

describe('accessibility', () => {
  it('gives the step heading focus so a change is announced', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'เริ่มสมัครสมาชิก' }));

    await waitFor(() => {
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading).toHaveTextContent('ถ่ายภาพบัตรประชาชน');
      expect(document.activeElement).toBe(heading);
    });
  });

  it('states progress as text as well as a bar', () => {
    render(<App />);

    expect(screen.getByText('ขั้นที่ 1 จาก 9')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  });

  it('labels every input on the identity step', async () => {
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);

    for (const input of screen.getAllByRole('textbox')) {
      // An unlabelled input is announced as "edit text" and nothing else.
      expect(input).toHaveAccessibleName();
    }
  });

  it('marks required fields with the attribute, not only an asterisk', async () => {
    const user = userEvent.setup();
    render(<App />);
    await reachIdentity(user);

    expect(screen.getByLabelText(/เลขบัตรประชาชน/)).toBeRequired();
    expect(screen.getByLabelText(/ชื่อ \(ภาษาไทย\)/)).toBeRequired();
    expect(screen.getByLabelText(/ชื่อ \(ภาษาอังกฤษ\)/)).not.toBeRequired();
  });
});

describe('Turnstile', () => {
  it('renders no widget and loads no third-party script when unconfigured', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'เริ่มสมัครสมาชิก' }));

    // Local development and CI have no site key. The server still decides, so a
    // browser that sends no token cannot talk its way past it.
    await waitFor(() => {
      expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    });
  });
});
