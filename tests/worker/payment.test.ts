import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createAuditLog } from '../../src/worker/services/audit';
import { createMemberPhotoService } from '../../src/worker/services/member-photo';
import { createPaymentService, PaymentRejectedError } from '../../src/worker/services/payment';
import { createStateMachine } from '../../src/worker/services/state-machine';
import { createMockSlipProvider } from '../../src/worker/providers/mock/slip';
import type { MockSlipOptions } from '../../src/worker/providers/mock/slip';
import type { Repository } from '../../src/worker/db';
import {
  FIVE_YEAR_SATANG,
  LIFETIME_SATANG,
  repository,
  seedApplication,
} from '../support/fixtures';

/**
 * Payment verification against the real database.
 *
 * These are the tests that decide whether someone can obtain a membership
 * without paying, without paying enough, or by reusing one payment twice.
 */

const ACCOUNT = {
  accountDigits: '1234567890',
  bankName: 'ธนาคารตัวอย่าง',
  accountName: 'สมาคมนักวิทยุอาสาสมัคร (ตัวอย่าง)',
};

const NOW = new Date('2026-08-20T10:00:00.000Z');

/**
 * A payment service wired to the mock provider.
 *
 * `transaction` is merged rather than replaced. A shallow spread would drop the
 * default timestamp whenever a test overrode any other field, and the mock's own
 * default is months old - so every such test would fail on the age check
 * instead of exercising what it meant to.
 */
function service(repo: Repository, slipOptions: MockSlipOptions = {}, now: () => Date = () => NOW) {
  return createPaymentService(
    repo,
    createMockSlipProvider({
      ...slipOptions,
      transaction: {
        receiverAccountDigits: '7890',
        transactionAt: NOW.toISOString(),
        ...slipOptions.transaction,
      },
    }),
    createStateMachine(repo),
    createAuditLog(repo),
    ACCOUNT,
    { now },
  );
}

/** An application selected a membership and is awaiting payment. */
async function readyToPay(
  repo: Repository,
  citizenId?: string,
  membership: 'FIVE_YEAR' | 'LIFETIME' = 'FIVE_YEAR',
): Promise<string> {
  const id = await seedApplication(repo, citizenId);
  await repo.applications.setMembership(
    id,
    membership,
    membership === 'FIVE_YEAR' ? FIVE_YEAR_SATANG : LIFETIME_SATANG,
  );
  await createStateMachine(repo).transition(id, 'AWAITING_PAYMENT');
  return id;
}

const QR = { kind: 'qr', payload: 'mock-qr-payload' } as const;

describe('accepting a valid payment', () => {
  it('verifies a five-year payment and moves the application on', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    const verified = await service(repo).verify({ applicationId: id, evidence: QR });

    expect(verified.amountSatang).toBe(FIVE_YEAR_SATANG);
    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'PAYMENT_VERIFIED',
    });
  });

  it('verifies a lifetime payment at the lifetime price', async () => {
    const repo = repository();
    const id = await readyToPay(repo, undefined, 'LIFETIME');

    const verified = await service(repo).verify({ applicationId: id, evidence: QR });

    expect(verified.amountSatang).toBe(LIFETIME_SATANG);
  });

  it('records the payment with both checks marked', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    await service(repo).verify({ applicationId: id, evidence: QR });

    const payments = await repo.payments.findByApplicationId(id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      receiverMatched: true,
      amountMatched: true,
      verificationStatus: 'VERIFIED',
      provider: 'mock-slip',
    });
  });

  it('records the audit events for the transition', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    await service(repo).verify({ applicationId: id, evidence: QR });

    const types = (await repo.events.listByApplicationId(id)).map((event) => event.eventType);
    expect(types).toContain('PAYMENT_VERIFIED');
  });

  it('stores no slip image anywhere', async () => {
    const repo = repository();
    const id = await readyToPay(repo);
    const jpeg = new Uint8Array(200);
    jpeg.set([0xff, 0xd8, 0xff], 0);

    await service(repo).verify({
      applicationId: id,
      evidence: { kind: 'image', image: { bytes: jpeg, contentType: 'image/jpeg' } },
    });

    // The slip must not be persisted (Issue #1 section 19). The photo service
    // shares the bucket, so an empty listing is the assertion.
    const photos = createMemberPhotoService(repo, env.MEMBER_PHOTOS, createAuditLog(repo));
    await expect(photos.read(id)).resolves.toBeNull();
  });
});

describe('the amount check', () => {
  it('refuses a slip for the wrong amount', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    // The applicant selected FIVE_YEAR but transferred the lifetime amount.
    const error = await service(repo, {
      transaction: { amount: LIFETIME_SATANG, receiverAccountDigits: '7890' },
    })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PaymentRejectedError);
    expect((error as PaymentRejectedError).reason).toBe('AMOUNT_MISMATCH');
  });

  it('refuses a slip for slightly too little', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    const error = await service(repo, {
      transaction: { amount: FIVE_YEAR_SATANG - 1, receiverAccountDigits: '7890' },
    })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('AMOUNT_MISMATCH');
  });

  it('records nothing when the amount is wrong', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    await service(repo, { transaction: { amount: 1, receiverAccountDigits: '7890' } })
      .verify({ applicationId: id, evidence: QR })
      .catch(() => undefined);

    await expect(repo.payments.findByApplicationId(id)).resolves.toEqual([]);
    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'AWAITING_PAYMENT',
    });
  });

  it('refuses when no membership type has been chosen', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    await createStateMachine(repo).transition(id, 'AWAITING_PAYMENT');

    const error = await service(repo)
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    // Without a type there is no expected amount, so nothing can be verified.
    expect((error as PaymentRejectedError).reason).toBe('MEMBERSHIP_NOT_SELECTED');
  });
});

describe('the receiver check', () => {
  it('refuses a transfer to a different account', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    const error = await service(repo, { transaction: { receiverAccountDigits: '5555' } })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('RECEIVER_MISMATCH');
  });

  it('refuses rather than guesses when the receiver cannot be identified', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    const error = await service(repo, { transaction: { receiverAccountDigits: null } })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('RECEIVER_UNVERIFIABLE');
  });

  it('records nothing when the receiver is wrong', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    await service(repo, { transaction: { receiverAccountDigits: '5555' } })
      .verify({ applicationId: id, evidence: QR })
      .catch(() => undefined);

    await expect(repo.payments.findByApplicationId(id)).resolves.toEqual([]);
  });
});

describe('the duplicate check', () => {
  it('refuses a slip that has already been used', async () => {
    const repo = repository();
    const first = await readyToPay(repo, '1234567890121');
    const second = await readyToPay(repo, '1234567890139');
    const sameSlip = {
      transaction: { transactionRef: 'SHARED-TXN', receiverAccountDigits: '7890' },
    };

    await service(repo, sameSlip).verify({ applicationId: first, evidence: QR });

    const error = await service(repo, sameSlip)
      .verify({ applicationId: second, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('DUPLICATE_SLIP');
    await expect(repo.applications.findById(second)).resolves.toMatchObject({
      status: 'AWAITING_PAYMENT',
    });
  });

  it('lets only one of two simultaneous submissions of the same slip through', async () => {
    const repo = repository();
    const first = await readyToPay(repo, '1234567890121');
    const second = await readyToPay(repo, '1234567890139');
    const sameSlip = { transaction: { transactionRef: 'RACE-TXN', receiverAccountDigits: '7890' } };

    // The unique constraint decides, not a prior read, so two slips arriving
    // together cannot both be accepted.
    const outcomes = await Promise.allSettled([
      service(repo, sameSlip).verify({ applicationId: first, evidence: QR }),
      service(repo, sameSlip).verify({ applicationId: second, evidence: QR }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  });

  it('passes through the provider’s own duplicate verdict', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    // SlipOK also tracks slips it has seen, which is a second independent check
    // on the one thing that would let someone join twice on one payment.
    const error = await service(repo, { failWith: 'DUPLICATE_SLIP' })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('DUPLICATE_SLIP');
  });
});

describe('the timestamp check', () => {
  it('refuses a transfer older than the window', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    const error = await service(repo, {
      transaction: {
        receiverAccountDigits: '7890',
        transactionAt: '2026-08-01T10:00:00.000Z',
      },
    })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('TRANSFER_TOO_OLD');
  });

  it('accepts a transfer inside the window', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    await expect(
      service(repo, {
        transaction: {
          receiverAccountDigits: '7890',
          transactionAt: '2026-08-19T10:00:00.000Z',
        },
      }).verify({ applicationId: id, evidence: QR }),
    ).resolves.toBeDefined();
  });

  it('refuses a transfer dated in the future', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    const error = await service(repo, {
      transaction: {
        receiverAccountDigits: '7890',
        transactionAt: '2026-08-21T10:00:00.000Z',
      },
    })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('TRANSFER_IN_FUTURE');
  });

  it('tolerates small clock skew', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    // Five minutes ahead is a clock difference, not a fraudulent slip.
    await expect(
      service(repo, {
        transaction: {
          receiverAccountDigits: '7890',
          transactionAt: '2026-08-20T10:05:00.000Z',
        },
      }).verify({ applicationId: id, evidence: QR }),
    ).resolves.toBeDefined();
  });

  it('accepts a slip with no timestamp rather than rejecting it', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    // Some banks omit the time. The other four checks still apply, and refusing
    // here would block legitimate payments over a field the bank chose to skip.
    await expect(
      service(repo, {
        transaction: { receiverAccountDigits: '7890', transactionAt: null },
      }).verify({ applicationId: id, evidence: QR }),
    ).resolves.toBeDefined();
  });
});

describe('provider failures', () => {
  it('reports an unreadable slip', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    const error = await service(repo, { failWith: 'SLIP_UNREADABLE' })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('SLIP_UNREADABLE');
  });

  it('reports a transaction the bank does not have', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    const error = await service(repo, { failWith: 'SLIP_NOT_FOUND' })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('SLIP_NOT_FOUND');
  });

  it('collapses a provider outage into one unavailable reason', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    for (const failure of ['PROVIDER_ERROR', 'PROVIDER_TIMEOUT'] as const) {
      const error = await service(repo, { failWith: failure })
        .verify({ applicationId: id, evidence: QR })
        .catch((reason: unknown) => reason);

      // The applicant does not need to know which; they need to know to retry.
      expect((error as PaymentRejectedError).reason).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  it('leaves the application untouched when the provider fails', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    await service(repo, { failWith: 'PROVIDER_TIMEOUT' })
      .verify({ applicationId: id, evidence: QR })
      .catch(() => undefined);

    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'AWAITING_PAYMENT',
    });
    await expect(repo.payments.findByApplicationId(id)).resolves.toEqual([]);
  });
});

describe('a payment that is not expected', () => {
  it('refuses a second payment for an application that is already paid', async () => {
    const repo = repository();
    const id = await readyToPay(repo);
    await service(repo).verify({ applicationId: id, evidence: QR });

    // The state machine treats a repeat transition into PAYMENT_VERIFIED as an
    // idempotent no-op, which is right in general. Here it would have meant a
    // second slip was recorded and reported as verified, so the status is
    // checked before anything else happens.
    const error = await service(repo, {
      transaction: { transactionRef: 'SECOND-TXN', receiverAccountDigits: '7890' },
    })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PaymentRejectedError);
    expect((error as PaymentRejectedError).reason).toBe('ALREADY_PAID');
  });

  it('records only the first payment', async () => {
    const repo = repository();
    const id = await readyToPay(repo);
    await service(repo).verify({ applicationId: id, evidence: QR });

    await service(repo, {
      transaction: { transactionRef: 'SECOND-TXN', receiverAccountDigits: '7890' },
    })
      .verify({ applicationId: id, evidence: QR })
      .catch(() => undefined);

    await expect(repo.payments.findByApplicationId(id)).resolves.toHaveLength(1);
  });

  it('tells the applicant how to get a duplicate transfer back', async () => {
    const repo = repository();
    const id = await readyToPay(repo);
    await service(repo).verify({ applicationId: id, evidence: QR });

    const error = await service(repo, { transaction: { transactionRef: 'SECOND-TXN' } })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    // If they really did transfer twice, the money is theirs to reclaim.
    expect((error as PaymentRejectedError).publicMessage).toContain('คืนเงิน');
  });

  it('records that a payment was presented when none was expected', async () => {
    const repo = repository();
    const id = await readyToPay(repo);
    await service(repo).verify({ applicationId: id, evidence: QR });

    await service(repo, { transaction: { transactionRef: 'SECOND-TXN' } })
      .verify({ applicationId: id, evidence: QR })
      .catch(() => undefined);

    const events = await repo.events.listByApplicationId(id);
    expect(events.map((event) => event.eventType)).toContain('PAYMENT_PRESENTED_WHEN_NOT_EXPECTED');
  });

  it('distinguishes not-yet-there from already-paid', async () => {
    const repo = repository();
    // Still a draft: the applicant has not reached the payment step.
    const id = await seedApplication(repo);
    await repo.applications.setMembership(id, 'FIVE_YEAR', FIVE_YEAR_SATANG);

    const error = await service(repo)
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('NOT_AWAITING_PAYMENT');
  });

  it('does not claim a refund is available when nothing was ever paid', async () => {
    const repo = repository();
    const id = await readyToPay(repo);
    // Rejected before paying. `REJECTED` is reachable both before and after
    // payment, so classifying by status would have told this applicant their
    // money is refundable when they never transferred any.
    await createStateMachine(repo).transition(id, 'REJECTED');

    const error = await service(repo)
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('NOT_AWAITING_PAYMENT');
    expect((error as PaymentRejectedError).publicMessage).not.toContain('คืนเงิน');
  });

  it('does offer a refund route when a payment exists', async () => {
    const repo = repository();
    const id = await readyToPay(repo);
    await service(repo).verify({ applicationId: id, evidence: QR });
    await createStateMachine(repo).transition(id, 'REJECTED');

    const error = await service(repo, { transaction: { transactionRef: 'SECOND-TXN' } })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    // Same status as the previous test, opposite advice, because this applicant
    // really did pay.
    expect((error as PaymentRejectedError).reason).toBe('ALREADY_PAID');
  });

  it('does not call the provider when a payment is not expected', async () => {
    const repo = repository();
    const id = await readyToPay(repo);
    await service(repo).verify({ applicationId: id, evidence: QR });

    // A provider configured to fail would surface its own reason if it were
    // called; getting ALREADY_PAID proves it was not.
    const error = await service(repo, { failWith: 'SLIP_NOT_FOUND' })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).reason).toBe('ALREADY_PAID');
  });
});

describe('applicant-facing messages', () => {
  it('names the actual problem rather than saying verification failed', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    const error = await service(repo, { transaction: { receiverAccountDigits: '5555' } })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    expect((error as PaymentRejectedError).publicMessage).toContain('บัญชีผู้รับ');
  });

  it('never exposes provider detail', async () => {
    const repo = repository();
    const id = await readyToPay(repo);

    const error = await service(repo, { failWith: 'PROVIDER_ERROR' })
      .verify({ applicationId: id, evidence: QR })
      .catch((reason: unknown) => reason);

    const message = (error as PaymentRejectedError).publicMessage.toLowerCase();
    for (const leak of ['slipok', 'api.slipok', 'x-authorization', '1012', '1013']) {
      expect(message).not.toContain(leak);
    }
  });
});
