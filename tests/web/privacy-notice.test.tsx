import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PrivacyNotice } from '../../src/web/privacy/PrivacyNotice';

describe('the full privacy notice', () => {
  it('identifies the controller, processors, retention and applicant rights', () => {
    render(<PrivacyNotice />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'ประกาศความเป็นส่วนตัวสำหรับการสมัครสมาชิก',
    );
    expect(
      screen.getByText(/สมาคมนักวิทยุอาสาสมัคร.*เป็นผู้ควบคุมข้อมูลส่วนบุคคล/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Cloudflare: hosting/)).toBeInTheDocument();
    expect(screen.getByText(/ใบสมัครที่ค้างและไม่มีการชำระเงิน/)).toHaveTextContent('30 วัน');
    expect(screen.getByText(/ใบสมัครที่เสร็จสมบูรณ์หรือคืนเงินแล้ว/)).toHaveTextContent('90 วัน');
    expect(screen.getByText(/เก็บเฉพาะข้อมูลอ้างอิง/)).toHaveTextContent('7 ปี');
    expect(screen.getByRole('heading', { name: 'สิทธิของท่าน' })).toBeInTheDocument();
  });
});
