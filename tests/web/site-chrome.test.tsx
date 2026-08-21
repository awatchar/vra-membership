import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/web/App';
import { AdminApp } from '../../src/web/admin/AdminApp';
import { SiteFooter } from '../../src/web/components/SiteFooter';
import type { AssociationContact } from '../../src/web/api/types';

/**
 * The header and footer that say whose system this is.
 *
 * The reason these are tested rather than eyeballed: an applicant is about to
 * type a citizen ID and transfer money, and the only thing that tells them whose
 * form this is, is what these two components render. A page that quietly stops
 * identifying the association is a trust failure, not a cosmetic one.
 */

const CONTACT: AssociationContact = {
  name: 'สมาคมนักวิทยุอาสาสมัคร',
  postalAddress: 'ตู้ ปณ.1 ปณฝ.บางแค 10161',
  email: 'turakanvra@gmail.com',
  lineId: 'vra2557',
  phone: '098 832 2522',
};

function stubConfig(association: AssociationContact | null = CONTACT): void {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.startsWith('/api/config')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            turnstileSiteKey: null,
            environment: 'development',
            association: association ?? CONTACT,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'ไม่พบ' } }), {
        status: 404,
      }),
    );
  });
}

beforeEach(() => stubConfig());
afterEach(() => vi.restoreAllMocks());

describe('the header', () => {
  it('names the association on the applicant wizard', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('banner')).toHaveTextContent('สมาคมนักวิทยุอาสาสมัคร');
    });
    expect(screen.getByRole('banner')).toHaveTextContent('ระบบรับสมัครสมาชิก');
  });

  it('gives the logo a name a screen reader can read', async () => {
    render(<App />);

    // Not decorative: it is one of the two things identifying the association,
    // so `alt=""` would hide it from exactly the people who need it named.
    await waitFor(() => {
      expect(screen.getByAltText(/ตราสัญลักษณ์สมาคมนักวิทยุอาสาสมัคร/)).toBeInTheDocument();
    });
  });

  it('reserves the logo box so the header does not reflow when it loads', async () => {
    render(<App />);

    const logo = await screen.findByAltText(/ตราสัญลักษณ์/);
    expect(logo).toHaveAttribute('width', '48');
    expect(logo).toHaveAttribute('height', '48');
  });

  it('names the association before the configuration has answered', () => {
    // A page that briefly claims to belong to nobody is worse than one that is
    // momentarily generic, so the name has a constant fallback.
    render(<App />);

    expect(screen.getByRole('banner')).toHaveTextContent('สมาคมนักวิทยุอาสาสมัคร');
  });

  it('still names it when the configuration call fails outright', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline')));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('banner')).toHaveTextContent('สมาคมนักวิทยุอาสาสมัคร');
    });
  });
});

describe('the footer', () => {
  it('carries every contact detail the association gave', async () => {
    render(<App />);
    const footer = await screen.findByRole('contentinfo');

    await waitFor(() => {
      expect(within(footer).getByText('ตู้ ปณ.1 ปณฝ.บางแค 10161')).toBeInTheDocument();
    });
    expect(within(footer).getByText('turakanvra@gmail.com')).toBeInTheDocument();
    expect(within(footer).getByText('vra2557')).toBeInTheDocument();
    expect(within(footer).getByText('098 832 2522')).toBeInTheDocument();
  });

  it('makes the email and the phone number usable in one tap', async () => {
    render(<App />);
    const footer = await screen.findByRole('contentinfo');

    await waitFor(() => {
      expect(within(footer).getByRole('link', { name: 'turakanvra@gmail.com' })).toHaveAttribute(
        'href',
        'mailto:turakanvra@gmail.com',
      );
    });
    // `tel:` needs the digits without spaces; the label keeps them for reading.
    expect(within(footer).getByRole('link', { name: '098 832 2522' })).toHaveAttribute(
      'href',
      'tel:0988322522',
    );
  });

  it('omits a line it has no value for, rather than showing a blank row', () => {
    render(
      <SiteFooter
        contact={{
          name: 'สมาคมทดสอบ',
          postalAddress: null,
          email: null,
          lineId: null,
          phone: null,
        }}
      />,
    );

    // A blank row or an example value would be worse than one fewer line:
    // somebody would try it.
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent('สมาคมทดสอบ');
    expect(within(footer).queryAllByRole('definition')).toHaveLength(0);
    expect(within(footer).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows only the values it has when some are missing', () => {
    render(
      <SiteFooter
        contact={{
          name: 'สมาคมทดสอบ',
          postalAddress: null,
          email: 'a@example.test',
          lineId: null,
          phone: null,
        }}
      />,
    );

    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getAllByRole('definition')).toHaveLength(1);
    expect(within(footer).getByText('a@example.test')).toBeInTheDocument();
  });

  it('pairs each value with the label it belongs to', async () => {
    render(<App />);
    const footer = await screen.findByRole('contentinfo');

    await waitFor(() => {
      expect(within(footer).getAllByRole('term')).toHaveLength(4);
    });
    // A definition list, so a screen reader announces "โทรศัพท์: 098…" rather
    // than a bare string of digits.
    expect(within(footer).getAllByRole('definition')).toHaveLength(4);
  });
});

describe('both halves of the site', () => {
  it('gives the wizard one banner, one main and one contentinfo', async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByRole('banner')).toBeInTheDocument());
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('identifies the manager portal too', async () => {
    render(<AdminApp />);

    await waitFor(() => {
      expect(screen.getByRole('banner')).toHaveTextContent('ระบบผู้จัดการ');
    });
    expect(screen.getByRole('banner')).toHaveTextContent('สมาคมนักวิทยุอาสาสมัคร');
  });

  it('shows the contact details on the portal page that says access was refused', async () => {
    // The page a manager reaches when Access has not let them in is the one they
    // most need a phone number on.
    render(<AdminApp />);

    await waitFor(() => {
      expect(screen.getByText('เข้าถึงระบบผู้จัดการไม่ได้')).toBeInTheDocument();
    });
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText('098 832 2522')).toBeInTheDocument();
  });

  it('keeps the header and footer on every step of the wizard', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'เริ่มสมัครสมาชิก' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ถ่ายภาพบัตรประชาชน');
    });
    expect(screen.getByRole('banner')).toHaveTextContent('สมาคมนักวิทยุอาสาสมัคร');
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });
});
