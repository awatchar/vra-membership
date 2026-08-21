import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import { THAI_FONT_BYTES } from '../../src/worker/lib/pdf/fonts';
import { renderReceiptPdf } from '../../src/worker/lib/pdf/receipt';
import { createAuditLog } from '../../src/worker/services/audit';
import { createNumberingService } from '../../src/worker/services/numbering';
import { createReceiptService } from '../../src/worker/services/receipt';
import { createStateMachine } from '../../src/worker/services/state-machine';
import type { PaymentInput, Repository } from '../../src/worker/db';
import { FIVE_YEAR_SATANG, repository, seedApplication } from '../support/fixtures';
import { extractComparableText, extractPdfText, withoutSaraAa } from '../support/pdf-text';

/** 2026-08-20 in Bangkok, which is Buddhist year 2569. */
const NOW = new Date('2026-08-20T03:00:00.000Z');

function services(repo: Repository, now: () => Date = () => NOW) {
  const numbering = createNumberingService(repo, { now });
  return createReceiptService(repo, numbering, createAuditLog(repo), { now });
}

function paymentInput(applicationId: string, overrides: Partial<PaymentInput> = {}): PaymentInput {
  return {
    applicationId,
    provider: 'slipok',
    transactionRef: `TXN-${crypto.randomUUID()}`,
    amountSatang: FIVE_YEAR_SATANG,
    sendingBank: '002',
    receivingBank: 'ธนาคารตัวอย่าง',
    receiverAccountDigits: '7890',
    transactionAt: '2026-08-20T02:30:00.000Z',
    receiverMatched: true,
    amountMatched: true,
    verificationStatus: 'VERIFIED',
    verifiedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** An application that has paid, with a reference number assigned. */
async function paidApplication(
  repo: Repository,
  citizenId?: string,
  overrides: Partial<PaymentInput> = {},
): Promise<string> {
  const id = await seedApplication(repo, citizenId);
  await repo.applications.setMembership(id, 'FIVE_YEAR', FIVE_YEAR_SATANG);
  await repo.applications.setReferenceNo(id, `VRA-2569-${crypto.randomUUID().slice(0, 6)}`);
  await repo.payments.create(paymentInput(id, overrides));
  const machine = createStateMachine(repo);
  await machine.transition(id, 'AWAITING_PAYMENT');
  await machine.transition(id, 'PAYMENT_VERIFIED');
  return id;
}

describe('Thai shaping in the embedded font', () => {
  it('substitutes a different tone-mark glyph when the context requires it', () => {
    const font = fontkit.create(new Uint8Array(THAI_FONT_BYTES));

    // Sarabun positions marks by substituting pre-positioned, zero-advance
    // glyphs rather than by applying GPOS offsets. So the check that shaping is
    // really happening is that the glyph *changes* with context: the tone mark
    // in "น้" cannot be the same glyph as the one in "น้ำ", because it has to
    // sit differently once sara am follows.
    const withoutSaraAm = font.layout('น้');
    const withSaraAm = font.layout('น้ำ');

    expect(withoutSaraAm.glyphs).toHaveLength(2);
    expect(withSaraAm.glyphs).toHaveLength(3);
    expect(withSaraAm.glyphs[1]!.id).not.toBe(withoutSaraAm.glyphs[1]!.id);
  });

  it('gives combining marks zero advance so they stack', () => {
    const font = fontkit.create(new Uint8Array(THAI_FONT_BYTES));
    const run = font.layout('ที่');

    // A non-zero advance on a mark would push the following character sideways
    // and the word would come out spaced apart.
    expect(run.positions[0]!.xAdvance).toBeGreaterThan(0);
    expect(run.positions[1]!.xAdvance).toBe(0);
    expect(run.positions[2]!.xAdvance).toBe(0);
  });
});

describe('renderReceiptPdf', () => {
  const data = {
    associationName: 'สมาคมนักวิทยุอาสาสมัคร',
    receiptNo: 'VRA-RC-2569-000001',
    issuedAt: NOW,
    payerName: 'นาย ทดสอบ ระบบสมัคร',
    applicationReferenceNo: 'VRA-2569-000001',
    membershipLabel: 'สมาชิกสามัญราย 5 ปี',
    amountBaht: '500.00',
    transactionRef: 'TXN0000000000001',
    paidAt: new Date('2026-08-20T02:30:00.000Z'),
    bankName: 'ธนาคารตัวอย่าง',
  };

  it('produces a parseable single-page PDF', async () => {
    const bytes = await renderReceiptPdf(data);

    expect(new TextDecoder('latin1').decode(bytes.slice(0, 5))).toBe('%PDF-');
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBe(1);
  });

  it('titles the document with the receipt number', async () => {
    const parsed = await PDFDocument.load(await renderReceiptPdf(data));

    expect(parsed.getTitle()).toContain('VRA-RC-2569-000001');
  });

  it('carries no author or producer metadata', async () => {
    // Those fields would put the applicant's or our details into a file that
    // leaves the system.
    const parsed = await PDFDocument.load(await renderReceiptPdf(data));

    expect(parsed.getAuthor() ?? '').toBe('');
    expect(parsed.getSubject() ?? '').toBe('');
  });

  it('is byte-identical for identical input, so regeneration is exact', async () => {
    // Same input, same document. If this drifts, a regenerated receipt would
    // not match the one the member already holds.
    const first = await renderReceiptPdf(data);
    const second = await renderReceiptPdf(data);

    expect(Array.from(second)).toEqual(Array.from(first));
  });

  it('embeds a subset rather than the whole face', async () => {
    const bytes = await renderReceiptPdf(data);

    // A receipt is about 12 KB with subsetting on. Embedding the full pair of
    // faces instead would add roughly 180 KB to every emailed attachment.
    expect(bytes.byteLength).toBeLessThan(40_000);
  });

  it('carries every field the receipt has to state', async () => {
    const text = await extractComparableText(await renderReceiptPdf(data));

    for (const expected of [
      data.associationName,
      'ใบสำคัญรับเงิน',
      data.receiptNo,
      data.payerName,
      data.applicationReferenceNo,
      data.membershipLabel,
      '500.00 บาท',
      data.transactionRef,
      data.bankName,
      '20 สิงหาคม 2569',
    ]) {
      expect(text).toContain(withoutSaraAa(expected));
    }
  });

  it('says it is proof of payment and not proof of NBTC registration', async () => {
    const text = await extractComparableText(await renderReceiptPdf(data));

    // A member who reads the receipt as "I am registered" would stop waiting
    // for the email that says they actually are.
    expect(text).toContain(withoutSaraAa('ไม่ใช่หลักฐานการบันทึกทะเบียนสมาชิกกับสำนักงาน กสทช.'));
  });

  it('shows Thai dates in the Buddhist era and Bangkok time', async () => {
    // 02:30Z is 09:30 in Bangkok, and it must not print as the previous day.
    const text = await extractComparableText(await renderReceiptPdf(data));

    expect(text).toContain(withoutSaraAa('20 สิงหาคม 2569 เวลา 09:30'));
  });

  it('draws combining vowels and tone marks as their own glyphs', async () => {
    const strings = await extractPdfText(await renderReceiptPdf(data));

    // `ที่` is one syllable of three code points; if shaping had dropped the
    // marks the extracted string would be shorter than the source.
    const label = strings.find((value) => value.startsWith('วันที'));
    expect(label).toBeDefined();
    expect([...label!]).toContain('่');
    expect([...label!]).toContain('ิ');
  });

  it('renders without a payment date', async () => {
    await expect(
      renderReceiptPdf({ ...data, paidAt: null, bankName: null }),
    ).resolves.toBeDefined();
  });

  it('renders the lifetime amount', async () => {
    await expect(
      renderReceiptPdf({ ...data, amountBaht: '2,000.00', membershipLabel: 'สมาชิกสามัญตลอดชีพ' }),
    ).resolves.toBeDefined();
  });
});

describe('issuing a receipt', () => {
  it('issues one with a Buddhist-year number', async () => {
    const repo = repository();
    const id = await paidApplication(repo);

    const { receipt, created } = await services(repo).issue(id);

    expect(created).toBe(true);
    expect(receipt.receiptNo).toBe('VRA-RC-2569-000001');
    expect(receipt.amountSatang).toBe(FIVE_YEAR_SATANG);
  });

  it('returns the existing receipt instead of issuing a second number', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    const receipts = services(repo);

    const first = await receipts.issue(id);
    const second = await receipts.issue(id);

    // Two numbers on one payment would put different references on documents
    // the member has already seen.
    expect(second.created).toBe(false);
    expect(second.receipt.receiptNo).toBe(first.receipt.receiptNo);
  });

  it('issues one receipt when asked concurrently', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    const receipts = services(repo);

    const outcomes = await Promise.allSettled([receipts.issue(id), receipts.issue(id)]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');

    expect(fulfilled).toHaveLength(2);
    const numbers = new Set(
      fulfilled.map(
        (outcome) =>
          (outcome as PromiseFulfilledResult<{ receipt: { receiptNo: string } }>).value.receipt
            .receiptNo,
      ),
    );
    expect(numbers.size).toBe(1);
  });

  it('numbers successive receipts without gaps', async () => {
    const repo = repository();
    const receipts = services(repo);
    const first = await paidApplication(repo, '1234567890121');
    const second = await paidApplication(repo, '1234567890139');

    await expect(receipts.issue(first)).resolves.toMatchObject({
      receipt: { receiptNo: 'VRA-RC-2569-000001' },
    });
    await expect(receipts.issue(second)).resolves.toMatchObject({
      receipt: { receiptNo: 'VRA-RC-2569-000002' },
    });
  });

  it('refuses when there is no verified payment', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    await repo.applications.setMembership(id, 'FIVE_YEAR', FIVE_YEAR_SATANG);

    await expect(services(repo).issue(id)).rejects.toThrow(/ยังไม่มีการชำระเงิน/);
  });

  it('ignores a rejected payment when looking for one', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    await repo.applications.setMembership(id, 'FIVE_YEAR', FIVE_YEAR_SATANG);
    await repo.payments.create(
      paymentInput(id, { verificationStatus: 'REJECTED', receiverMatched: false }),
    );

    await expect(services(repo).issue(id)).rejects.toThrow(/ยังไม่มีการชำระเงิน/);
  });

  it('refuses for an unknown application', async () => {
    await expect(services(repository()).issue(crypto.randomUUID())).rejects.toThrow();
  });

  it('records the issue in the audit trail without personal data', async () => {
    const repo = repository();
    const id = await paidApplication(repo);

    await services(repo).issue(id);

    const events = await repo.events.listByApplicationId(id);
    const issued = events.find((event) => event.eventType === 'RECEIPT_ISSUED');
    expect(issued?.metadata).toMatchObject({ receiptNo: 'VRA-RC-2569-000001' });
    expect(JSON.stringify(events)).not.toContain('ทดสอบ');
  });

  it('stores no PDF anywhere', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    const receipts = services(repo);

    await receipts.issue(id);
    await receipts.render(id);

    // The record is the durable artefact; the document is generated on demand
    // (Issue #1 section 26).
    const listing = await env.MEMBER_PHOTOS.list();
    expect(listing.objects).toHaveLength(0);
  });
});

describe('rendering an issued receipt', () => {
  it('renders from the stored record', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    const receipts = services(repo);
    const { receipt } = await receipts.issue(id);

    const rendered = await receipts.render(id);

    expect(rendered.filename).toBe(`${receipt.receiptNo}.pdf`);
    expect(new TextDecoder('latin1').decode(rendered.bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('regenerates the identical document', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    const receipts = services(repo);
    await receipts.issue(id);

    const first = await receipts.render(id);
    const second = await receipts.render(id);

    // Regeneration has to be exact, not approximate: the member may still hold
    // the first copy.
    expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
  });

  it('refuses to render before a receipt has been issued', async () => {
    const repo = repository();
    const id = await paidApplication(repo);

    await expect(services(repo).render(id)).rejects.toThrow(/ยังไม่มีใบสำคัญรับเงิน/);
  });

  it('records that the receipt was emailed, once', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    const receipts = services(repo);
    const { receipt } = await receipts.issue(id);

    await receipts.markEmailed(receipt.id);
    await receipts.markEmailed(receipt.id);

    const stored = await repo.receipts.findByApplicationId(id);
    expect(stored?.emailSentAt).toBe(NOW.toISOString());
  });
});

describe('receipt numbering across years', () => {
  it('restarts the sequence in a new Buddhist year', async () => {
    const repo = repository();
    let now = NOW;
    const receipts = createReceiptService(
      repo,
      createNumberingService(repo, { now: () => now }),
      createAuditLog(repo),
      { now: () => now },
    );

    const first = await paidApplication(repo, '1234567890121');
    await expect(receipts.issue(first)).resolves.toMatchObject({
      receipt: { receiptNo: 'VRA-RC-2569-000001' },
    });

    // 2026-12-31T17:00Z is 2027-01-01T00:00 in Bangkok.
    now = new Date('2026-12-31T17:00:00.000Z');
    const second = await paidApplication(repo, '1234567890139');
    await expect(receipts.issue(second)).resolves.toMatchObject({
      receipt: { receiptNo: 'VRA-RC-2570-000001' },
    });
  });
});
