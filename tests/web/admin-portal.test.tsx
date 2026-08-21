import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminApp } from '../../src/web/admin/AdminApp';
import type { AdminDetail, AdminListItem } from '../../src/web/admin/api';

/**
 * The manager portal, driven the way a manager drives it.
 *
 * `fetch` is stubbed per test. Every value is synthetic: the citizen ID is a
 * sequential pattern with a valid check digit, names are the Thai words for
 * "test", and addresses use the reserved `.test` TLD.
 */

const MANAGER = 'manager@example.test';
const CSRF = { header: 'x-vra-csrf', token: 'c'.repeat(64) };
const APPLICATION_ID = '11111111-2222-4333-8444-555555555555';
const CITIZEN_ID = '1234567890121';

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
}

let calls: Recorded[] = [];
let routes: Map<string, { status?: number; body?: unknown }>;

function detailBody(overrides: Partial<AdminDetail['application']> = {}): AdminDetail {
  return {
    application: {
      id: APPLICATION_ID,
      referenceNo: 'VRA-2569-000123',
      status: 'MANAGER_NOTIFIED',
      title: 'นาย',
      firstName: 'ทดสอบ',
      lastName: 'ระบบสมัคร',
      firstNameEn: 'Thodsob',
      lastNameEn: 'Rabobsamak',
      birthDate: '1990-01-15',
      cardExpiryDate: '2032-01-14',
      phone: '0812345678',
      email: 'applicant@example.test',
      callsign: 'HS0TEST',
      membershipType: 'ANNUAL',
      membershipLabel: 'สมาชิกสามัญรายปี',
      amountBaht: '500.00',
      hasPhoto: true,
      photoSource: 'UPLOAD',
      submittedAt: '2026-08-20T03:00:00.000Z',
      managerAcknowledgedAt: null,
      nbtcRecordedAt: null,
      nbtcRecordedBy: null,
      createdAt: '2026-08-20T02:00:00.000Z',
      updatedAt: '2026-08-20T03:00:00.000Z',
      ...overrides,
    },
    address: {
      idAddress: '99/9 หมู่ 9',
      idSubdistrict: 'ตำบลทดสอบ',
      idDistrict: 'อำเภอทดสอบ',
      idProvince: 'จังหวัดทดสอบ',
      mailSameAsId: true,
      mailRecipient: null,
      mailAddress: null,
      mailSubdistrict: null,
      mailDistrict: null,
      mailProvince: null,
      mailPostcode: '10200',
      mailPhone: null,
    },
    payment: {
      transactionRef: 'TXN0000000000001',
      amountBaht: '500.00',
      sendingBank: '002',
      receivingBank: 'ธนาคารตัวอย่าง',
      transactionAt: '2026-08-20T02:30:00.000Z',
      verifiedAt: '2026-08-20T02:31:00.000Z',
    },
    receipt: {
      receiptNo: 'VRA-RC-2569-000001',
      amountBaht: '500.00',
      issuedAt: '2026-08-20T02:31:00.000Z',
    },
    workflow: {
      referenceNo: 'VRA-2569-000123',
      receiptNo: 'VRA-RC-2569-000001',
      status: 'MANAGER_NOTIFIED',
      steps: {
        APPLICATION_NUMBER: 'DONE',
        RECEIPT: 'DONE',
        RECEIPT_EMAIL: 'DONE',
        SUBMISSION: 'DONE',
        MANAGER_EMAIL: 'DONE',
      },
      complete: true,
    },
    events: [
      {
        id: 'event-1',
        eventType: 'PAYMENT_VERIFIED',
        actorType: 'SYSTEM',
        actorId: null,
        metadata: { amountSatang: 50000 },
        createdAt: '2026-08-20T02:31:00.000Z',
      },
      {
        id: 'event-2',
        eventType: 'MANAGER_EMAIL_SENT',
        actorType: 'SYSTEM',
        actorId: null,
        metadata: { emailType: 'MANAGER_NEW_APPLICATION' },
        createdAt: '2026-08-20T03:00:00.000Z',
      },
    ],
  };
}

const QUEUE: AdminListItem[] = [
  {
    id: APPLICATION_ID,
    referenceNo: 'VRA-2569-000123',
    status: 'MANAGER_NOTIFIED',
    name: 'นาย ทดสอบ ระบบสมัคร',
    membershipType: 'ANNUAL',
    amountBaht: '500.00',
    submittedAt: '2026-08-20T03:00:00.000Z',
    createdAt: '2026-08-20T02:00:00.000Z',
  },
];

function route(path: string, body: unknown, status = 200): void {
  routes.set(path, { body, status });
}

function stubFetch(): void {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });

    const key = [...routes.keys()]
      .sort((a, b) => b.length - a.length)
      .find((candidate) => url.startsWith(candidate));
    const entry = key ? routes.get(key)! : undefined;

    if (!entry) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'ไม่พบ' } }), {
          status: 404,
        }),
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify(entry.body ?? {}), {
        status: entry.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

function visit(path: string): void {
  window.history.pushState(null, '', path);
}

beforeEach(() => {
  calls = [];
  routes = new Map();
  route('/api/admin/session', { manager: { email: MANAGER }, csrf: CSRF });
  route('/api/admin/applications', { applications: QUEUE });
  route(`/api/admin/applications/${APPLICATION_ID}`, { detail: detailBody() });
  stubFetch();
  visit('/admin');
});

afterEach(() => {
  vi.restoreAllMocks();
  visit('/');
});

describe('the session', () => {
  it('renders nothing until Access is confirmed', async () => {
    render(<AdminApp />);

    expect(screen.getByText('กำลังตรวจสอบสิทธิ์...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(MANAGER)).toBeInTheDocument());
  });

  it('shows no portal at all when the session call is refused', async () => {
    route(
      '/api/admin/session',
      { error: { code: 'FORBIDDEN', message: 'ไม่มีสิทธิ์เข้าถึงส่วนผู้จัดการ' } },
      403,
    );
    render(<AdminApp />);

    // A portal that renders while every action fails is worse than saying so.
    await waitFor(() => {
      expect(screen.getByText('ไม่มีสิทธิ์เข้าถึงส่วนผู้จัดการ')).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'ใบสมัครสมาชิก' })).not.toBeInTheDocument();
  });
});

describe('the queue', () => {
  it('opens on the applications that need the manager', async () => {
    render(<AdminApp />);

    await waitFor(() => expect(screen.getByText('VRA-2569-000123')).toBeInTheDocument());
    // The default filter is the outstanding work, not everything.
    const listCall = calls.find((call) => call.url.includes('/api/admin/applications?'));
    expect(listCall?.url).toContain('status=MANAGER_NOTIFIED,NBTC_PROCESSING');
  });

  it('shows a status in words, not only a colour', async () => {
    render(<AdminApp />);

    await waitFor(() => {
      expect(screen.getByText('รอผู้จัดการรับเรื่อง')).toBeInTheDocument();
    });
  });

  it('carries no personal detail beyond a name', async () => {
    render(<AdminApp />);
    await waitFor(() => expect(screen.getByText('VRA-2569-000123')).toBeInTheDocument());

    // This is the view most likely to be left open on a shared screen.
    const body = document.body.textContent ?? '';
    expect(body).not.toContain(CITIZEN_ID);
    expect(body).not.toContain('applicant@example.test');
    expect(body).not.toContain('จังหวัดทดสอบ');
  });

  it('changes the filter and asks the server again', async () => {
    const user = userEvent.setup();
    render(<AdminApp />);
    await waitFor(() => expect(screen.getByText('VRA-2569-000123')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'เสร็จสมบูรณ์' }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('status=COMPLETED,NBTC_RECORDED'))).toBe(true);
    });
  });

  it('offers a retry when the list cannot be loaded', async () => {
    route(
      '/api/admin/applications',
      { error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดภายในระบบ' } },
      500,
    );
    const user = userEvent.setup();
    render(<AdminApp />);

    await waitFor(() => expect(screen.getByText('เกิดข้อผิดพลาดภายในระบบ')).toBeInTheDocument());
    const before = calls.length;
    await user.click(screen.getByRole('button', { name: 'ลองโหลดอีกครั้ง' }));

    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('links to a detail with a real href, so it can be opened in a new tab', async () => {
    render(<AdminApp />);

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /ทดสอบ/ });
      expect(link).toHaveAttribute('href', `/admin/applications/${APPLICATION_ID}`);
    });
  });
});

describe('the detail', () => {
  beforeEach(() => visit(`/admin/applications/${APPLICATION_ID}`));

  it('shows the application without asking for the citizen ID', async () => {
    render(<AdminApp />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'VRA-2569-000123' })).toBeInTheDocument();
    });

    // Opening a page must not produce an access event for the number.
    expect(calls.some((call) => call.url.endsWith('/citizen-id'))).toBe(false);
    expect(document.body.textContent).not.toContain(CITIZEN_ID);
  });

  it('fetches the citizen ID only when asked, and says the read is recorded', async () => {
    route(`/api/admin/applications/${APPLICATION_ID}/citizen-id`, { citizenId: CITIZEN_ID });
    const user = userEvent.setup();
    render(<AdminApp />);
    await waitFor(() => expect(screen.getByText('เลขบัตรประชาชน')).toBeInTheDocument());

    expect(screen.getByText(/การเปิดดูจะถูกบันทึกไว้/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'แสดงเลขบัตรประชาชน' }));

    await waitFor(() => expect(screen.getByText(CITIZEN_ID)).toBeInTheDocument());
    expect(calls.filter((call) => call.url.endsWith('/citizen-id'))).toHaveLength(1);
  });

  it('reports a citizen ID that cannot be decrypted', async () => {
    route(`/api/admin/applications/${APPLICATION_ID}/citizen-id`, { citizenId: null });
    const user = userEvent.setup();
    render(<AdminApp />);
    await waitFor(() => expect(screen.getByText('เลขบัตรประชาชน')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'แสดงเลขบัตรประชาชน' }));

    await waitFor(() => {
      expect(screen.getByText(/ไม่สามารถอ่านเลขบัตรประชาชน/)).toBeInTheDocument();
    });
  });

  it('shows dates in Bangkok time and the Buddhist era', async () => {
    render(<AdminApp />);

    await waitFor(() => {
      // 1990-01-15 is 2533 in the Buddhist era.
      expect(screen.getByText('15 มกราคม 2533')).toBeInTheDocument();
    });
    // 02:30Z is 09:30 in Bangkok, on the same day.
    expect(screen.getByText(/20 สิงหาคม 2569 เวลา 09:30/)).toBeInTheDocument();
  });

  it('loads the photo from the authenticated endpoint', async () => {
    render(<AdminApp />);

    await waitFor(() => {
      const photo = screen.getByAltText('รูปสำหรับบัตรสมาชิกของผู้สมัคร');
      // No signed or durable URL: the browser sends the Access cookie itself.
      expect(photo).toHaveAttribute('src', `/api/admin/applications/${APPLICATION_ID}/photo`);
    });
  });

  it('links to the receipt', async () => {
    render(<AdminApp />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /ดาวน์โหลดใบสำคัญรับเงิน/ })).toHaveAttribute(
        'href',
        `/api/admin/applications/${APPLICATION_ID}/receipt`,
      );
    });
  });

  it('translates the audit trail rather than showing raw event names', async () => {
    render(<AdminApp />);

    await waitFor(() => {
      expect(screen.getByText('ตรวจสอบการชำระเงินผ่าน')).toBeInTheDocument();
      expect(screen.getByText('แจ้งผู้จัดการทางอีเมล')).toBeInTheDocument();
    });
    expect(screen.queryByText('PAYMENT_VERIFIED')).not.toBeInTheDocument();
  });

  it('offers the action the current status allows, and no other', async () => {
    render(<AdminApp />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'รับเรื่อง / เริ่มดำเนินการ' }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: 'บันทึกในระบบ กสทช. เรียบร้อยแล้ว' }),
    ).not.toBeInTheDocument();
  });

  it('offers the NBTC action once the application is in processing', async () => {
    route(`/api/admin/applications/${APPLICATION_ID}`, {
      detail: detailBody({ status: 'NBTC_PROCESSING' }),
    });
    render(<AdminApp />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'บันทึกในระบบ กสทช. เรียบร้อยแล้ว' }),
      ).toBeInTheDocument();
    });
  });

  it('surfaces an outstanding post-payment step with a retry', async () => {
    const detail = detailBody();
    detail.workflow.steps.RECEIPT_EMAIL = 'FAILED';
    detail.workflow.complete = false;
    route(`/api/admin/applications/${APPLICATION_ID}`, { detail });
    render(<AdminApp />);

    await waitFor(() => {
      expect(screen.getByText('ส่งใบสำคัญรับเงินให้สมาชิก')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: 'ลองดำเนินการขั้นตอนที่ค้างอีกครั้ง' }),
    ).toBeInTheDocument();
  });
});

describe('the confirmation page reached from the email', () => {
  it('changes nothing on load', async () => {
    visit(`/admin/applications/${APPLICATION_ID}/nbtc-complete`);
    route(`/api/admin/applications/${APPLICATION_ID}`, {
      detail: detailBody({ status: 'NBTC_PROCESSING' }),
    });
    render(<AdminApp />);

    await waitFor(() => {
      expect(screen.getByText(/กรุณายืนยันว่าได้บันทึกข้อมูลทะเบียนสมาชิก/)).toBeInTheDocument();
    });

    // An email security scanner opens links. Nothing here may act on its own.
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('shows who and what before asking', async () => {
    visit(`/admin/applications/${APPLICATION_ID}/nbtc-complete`);
    route(`/api/admin/applications/${APPLICATION_ID}`, {
      detail: detailBody({ status: 'NBTC_PROCESSING' }),
    });
    render(<AdminApp />);

    await waitFor(() => {
      expect(screen.getByText('VRA-2569-000123')).toBeInTheDocument();
      expect(screen.getByText('นาย ทดสอบ ระบบสมัคร')).toBeInTheDocument();
    });
  });

  it('posts with the CSRF token when confirmed', async () => {
    visit(`/admin/applications/${APPLICATION_ID}/nbtc-complete`);
    route(`/api/admin/applications/${APPLICATION_ID}`, {
      detail: detailBody({ status: 'NBTC_PROCESSING' }),
    });
    route(`/api/admin/applications/${APPLICATION_ID}/nbtc-complete`, {
      completion: {
        applicationId: APPLICATION_ID,
        status: 'COMPLETED',
        recorded: 'DONE',
        completionEmail: 'DONE',
        completed: 'DONE',
        complete: true,
      },
    });
    const user = userEvent.setup();
    render(<AdminApp />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'ยืนยันว่าบันทึกเรียบร้อยแล้ว' }),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: 'ยืนยันว่าบันทึกเรียบร้อยแล้ว' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST');
      expect(post?.url).toContain('/nbtc-complete');
      expect(post?.headers.get(CSRF.header)).toBe(CSRF.token);
    });
  });

  it('reports a partial result honestly', async () => {
    visit(`/admin/applications/${APPLICATION_ID}/nbtc-complete`);
    route(`/api/admin/applications/${APPLICATION_ID}`, {
      detail: detailBody({ status: 'NBTC_PROCESSING' }),
    });
    route(`/api/admin/applications/${APPLICATION_ID}/nbtc-complete`, {
      completion: {
        applicationId: APPLICATION_ID,
        status: 'NBTC_RECORDED',
        recorded: 'DONE',
        completionEmail: 'FAILED',
        completed: 'SKIPPED',
        complete: false,
      },
    });
    const user = userEvent.setup();
    render(<AdminApp />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'ยืนยันว่าบันทึกเรียบร้อยแล้ว' }),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: 'ยืนยันว่าบันทึกเรียบร้อยแล้ว' }));

    // "Done" would be a lie when the member has not been told.
    await waitFor(() => {
      expect(screen.getByText(/การแจ้งสมาชิกยังไม่สำเร็จ/)).toBeInTheDocument();
    });
  });

  it('sends one request for two presses', async () => {
    visit(`/admin/applications/${APPLICATION_ID}/acknowledge`);
    route(`/api/admin/applications/${APPLICATION_ID}/acknowledge`, {
      transition: 'APPLIED',
      processingEmailSent: true,
    });
    const user = userEvent.setup();
    render(<AdminApp />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'ยืนยันว่ารับเรื่องแล้ว' })).toBeInTheDocument(),
    );

    const button = screen.getByRole('button', { name: 'ยืนยันว่ารับเรื่องแล้ว' });
    await user.click(button);
    await user.click(button);

    await waitFor(() => expect(screen.getByText('บันทึกการรับเรื่องแล้ว')).toBeInTheDocument());
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('says the work is already done when an old email is opened again', async () => {
    visit(`/admin/applications/${APPLICATION_ID}/acknowledge`);
    route(`/api/admin/applications/${APPLICATION_ID}`, {
      detail: detailBody({ status: 'COMPLETED' }),
    });
    render(<AdminApp />);

    // A stale link must not present a button that would fail, leaving the
    // manager unsure whether their first press worked.
    await waitFor(() => expect(screen.getByText('ดำเนินการนี้ไปแล้ว')).toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: 'ยืนยันว่ารับเรื่องแล้ว' }),
    ).not.toBeInTheDocument();
  });

  it('refuses to offer an action the status does not allow yet', async () => {
    visit(`/admin/applications/${APPLICATION_ID}/nbtc-complete`);
    render(<AdminApp />);

    await waitFor(() => expect(screen.getByText('ยังไม่ถึงขั้นตอนนี้')).toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: 'ยืนยันว่าบันทึกเรียบร้อยแล้ว' }),
    ).not.toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('walks from the queue to a detail and back', async () => {
    const user = userEvent.setup();
    render(<AdminApp />);
    await waitFor(() => expect(screen.getByText('VRA-2569-000123')).toBeInTheDocument());

    await user.click(screen.getByRole('link', { name: /ทดสอบ/ }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'VRA-2569-000123' })).toBeInTheDocument(),
    );
    expect(window.location.pathname).toBe(`/admin/applications/${APPLICATION_ID}`);

    await user.click(screen.getByRole('button', { name: '← รายการใบสมัคร' }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'ใบสมัครสมาชิก' })).toBeInTheDocument(),
    );
  });

  it('reports an address that is not a portal page', async () => {
    visit('/admin/nonsense');
    render(<AdminApp />);

    await waitFor(() => expect(screen.getByText('ไม่พบหน้านี้')).toBeInTheDocument());
  });

  it('reports a malformed application id rather than requesting it', async () => {
    visit('/admin/applications/not-a-uuid');
    render(<AdminApp />);

    await waitFor(() => expect(screen.getByText('ไม่พบหน้านี้')).toBeInTheDocument());
    expect(calls.some((call) => call.url.includes('not-a-uuid'))).toBe(false);
  });
});

describe('client-side storage', () => {
  it('writes nothing, including the CSRF token', async () => {
    route(`/api/admin/applications/${APPLICATION_ID}/citizen-id`, { citizenId: CITIZEN_ID });
    const user = userEvent.setup();
    visit(`/admin/applications/${APPLICATION_ID}`);
    render(<AdminApp />);
    await waitFor(() => expect(screen.getByText('เลขบัตรประชาชน')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'แสดงเลขบัตรประชาชน' }));
    await waitFor(() => expect(screen.getByText(CITIZEN_ID)).toBeInTheDocument());

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('the detail layout', () => {
  it('labels every value it shows', async () => {
    visit(`/admin/applications/${APPLICATION_ID}`);
    render(<AdminApp />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'VRA-2569-000123' })).toBeInTheDocument(),
    );

    // A definition list, so each value is announced with the term it belongs to
    // rather than as a bare string.
    const applicant = screen.getByRole('heading', { name: 'ผู้สมัคร' }).parentElement!;
    const terms = within(applicant).getAllByRole('term');
    expect(terms.length).toBeGreaterThan(0);
    expect(within(applicant).getAllByRole('definition').length).toBe(terms.length);
  });
});
