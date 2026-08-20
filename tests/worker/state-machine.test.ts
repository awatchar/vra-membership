import { describe, expect, it } from 'vitest';
import { APPLICATION_STATUSES } from '../../src/worker/db';
import type { ApplicationStatus, Repository } from '../../src/worker/db';
import {
  allowedTargets,
  createStateMachine,
  isTransitionAllowed,
  predecessorsOf,
  TERMINAL_STATUSES,
} from '../../src/worker/services/state-machine';
import { repository, seedApplication } from '../support/fixtures';

function machine(repo: Repository) {
  return createStateMachine(repo);
}

/** Walks an application to `target` through the legal happy path. */
const HAPPY_PATH: readonly ApplicationStatus[] = [
  'AWAITING_PAYMENT',
  'PAYMENT_VERIFIED',
  'SUBMITTED',
  'MANAGER_NOTIFIED',
  'NBTC_PROCESSING',
  'NBTC_RECORDED',
  'COMPLETED',
];

async function walkTo(
  repo: Repository,
  applicationId: string,
  target: ApplicationStatus,
): Promise<void> {
  const stateMachine = machine(repo);
  for (const status of HAPPY_PATH) {
    const outcome = await stateMachine.transition(applicationId, status);
    expect(outcome.kind).toBe('APPLIED');
    if (status === target) return;
  }
  if (target !== 'COMPLETED') {
    throw new Error(`${target} is not on the happy path`);
  }
}

describe('transition table', () => {
  it('covers every status', () => {
    for (const status of APPLICATION_STATUSES) {
      expect(allowedTargets(status)).toBeDefined();
    }
  });

  it('matches the flow in Issue #1 section 41', () => {
    expect(allowedTargets('DRAFT')).toContain('AWAITING_PAYMENT');
    expect(allowedTargets('AWAITING_PAYMENT')).toContain('PAYMENT_VERIFIED');
    expect(allowedTargets('PAYMENT_VERIFIED')).toContain('SUBMITTED');
    expect(allowedTargets('SUBMITTED')).toContain('MANAGER_NOTIFIED');
    expect(allowedTargets('MANAGER_NOTIFIED')).toContain('NBTC_PROCESSING');
    expect(allowedTargets('NBTC_PROCESSING')).toContain('NBTC_RECORDED');
    expect(allowedTargets('NBTC_RECORDED')).toContain('COMPLETED');
  });

  it('never allows a status to transition to itself', () => {
    for (const status of APPLICATION_STATUSES) {
      expect(isTransitionAllowed(status, status)).toBe(false);
    }
  });

  it('never allows a step backwards along the happy path', () => {
    const path: ApplicationStatus[] = ['DRAFT', ...HAPPY_PATH];
    for (let index = 1; index < path.length; index += 1) {
      expect(isTransitionAllowed(path[index]!, path[index - 1]!)).toBe(false);
    }
  });

  it('never allows skipping a step on the happy path', () => {
    const path: ApplicationStatus[] = ['DRAFT', ...HAPPY_PATH];
    for (let index = 0; index + 2 < path.length; index += 1) {
      expect(isTransitionAllowed(path[index]!, path[index + 2]!)).toBe(false);
    }
  });

  it('treats COMPLETED, CANCELLED and REFUNDED as terminal', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['CANCELLED', 'COMPLETED', 'REFUNDED']);
  });

  it('only allows a refund once money has been taken', () => {
    expect(isTransitionAllowed('DRAFT', 'REFUND_REQUIRED')).toBe(false);
    expect(isTransitionAllowed('AWAITING_PAYMENT', 'REFUND_REQUIRED')).toBe(false);
    expect(isTransitionAllowed('PAYMENT_VERIFIED', 'REFUND_REQUIRED')).toBe(true);
  });

  it('only allows cancelling before money has been taken', () => {
    expect(isTransitionAllowed('DRAFT', 'CANCELLED')).toBe(true);
    expect(isTransitionAllowed('AWAITING_PAYMENT', 'CANCELLED')).toBe(true);
    expect(isTransitionAllowed('PAYMENT_VERIFIED', 'CANCELLED')).toBe(false);
  });

  it('reports predecessors consistently with the forward table', () => {
    for (const to of APPLICATION_STATUSES) {
      for (const from of predecessorsOf(to)) {
        expect(isTransitionAllowed(from, to)).toBe(true);
      }
    }
  });
});

describe('applying transitions', () => {
  it('walks the whole happy path', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stateMachine = machine(repo);

    for (const status of HAPPY_PATH) {
      await expect(stateMachine.transition(id, status)).resolves.toMatchObject({
        kind: 'APPLIED',
        to: status,
      });
    }

    await expect(repo.applications.findById(id)).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('refuses a transition that is not in the table', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await expect(machine(repo).transition(id, 'COMPLETED')).resolves.toEqual({
      kind: 'NOT_ALLOWED',
      from: 'DRAFT',
      to: 'COMPLETED',
    });
    await expect(repo.applications.findById(id)).resolves.toMatchObject({ status: 'DRAFT' });
  });

  it('reports NOT_FOUND for an unknown application', async () => {
    const repo = repository();

    await expect(
      machine(repo).transition(crypto.randomUUID(), 'AWAITING_PAYMENT'),
    ).resolves.toEqual({ kind: 'NOT_FOUND' });
  });

  it('records the timestamps that belong to the transition', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    await walkTo(repo, id, 'PAYMENT_VERIFIED');

    await machine(repo).transition(id, 'SUBMITTED', {
      timestamps: { submittedAt: '2026-03-04T05:06:07.000Z' },
    });

    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'SUBMITTED',
      submittedAt: '2026-03-04T05:06:07.000Z',
    });
  });

  it('records who performed a manager action', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    await walkTo(repo, id, 'NBTC_PROCESSING');

    await machine(repo).transition(id, 'NBTC_RECORDED', {
      actorType: 'MANAGER',
      actorId: 'manager@example.test',
      timestamps: {
        nbtcRecordedAt: '2026-04-05T06:07:08.000Z',
        nbtcRecordedBy: 'manager@example.test',
      },
    });

    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'NBTC_RECORDED',
      nbtcRecordedBy: 'manager@example.test',
    });
  });
});

describe('idempotency', () => {
  it('treats a repeated transition as a no-op', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stateMachine = machine(repo);

    await stateMachine.transition(id, 'AWAITING_PAYMENT');

    await expect(stateMachine.transition(id, 'AWAITING_PAYMENT')).resolves.toEqual({
      kind: 'ALREADY_IN_TARGET_STATE',
      status: 'AWAITING_PAYMENT',
    });
  });

  it('does not record a second audit event for a repeated transition', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stateMachine = machine(repo);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await stateMachine.transition(id, 'AWAITING_PAYMENT');
    }

    const events = await repo.events.listByApplicationId(id);
    expect(events.filter((event) => event.eventType === 'STATUS_CHANGED')).toHaveLength(1);
  });

  it('lets exactly one of many concurrent identical transitions apply', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stateMachine = machine(repo);

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => stateMachine.transition(id, 'AWAITING_PAYMENT')),
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'APPLIED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'ALREADY_IN_TARGET_STATE')).toHaveLength(
      9,
    );

    const events = await repo.events.listByApplicationId(id);
    expect(events.filter((event) => event.eventType === 'STATUS_CHANGED')).toHaveLength(1);
  });

  it('does not record the domain event twice', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stateMachine = machine(repo);
    await stateMachine.transition(id, 'AWAITING_PAYMENT');

    await Promise.all(
      Array.from({ length: 5 }, () =>
        stateMachine.transition(id, 'PAYMENT_VERIFIED', { domainEvent: 'PAYMENT_VERIFIED' }),
      ),
    );

    const events = await repo.events.listByApplicationId(id);
    expect(events.filter((event) => event.eventType === 'PAYMENT_VERIFIED')).toHaveLength(1);
  });
});

describe('audit trail', () => {
  it('records STATUS_CHANGED with the statuses only', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await machine(repo).transition(id, 'AWAITING_PAYMENT');

    const [event] = await repo.events.listByApplicationId(id);
    expect(event).toMatchObject({
      eventType: 'STATUS_CHANGED',
      actorType: 'SYSTEM',
      metadata: { from: 'DRAFT', to: 'AWAITING_PAYMENT' },
    });
  });

  it('records the domain event before the status change', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stateMachine = machine(repo);
    await stateMachine.transition(id, 'AWAITING_PAYMENT');

    await stateMachine.transition(id, 'PAYMENT_VERIFIED', { domainEvent: 'PAYMENT_VERIFIED' });

    // Asserted as an exact sequence rather than with index arithmetic: both
    // events of one transition share a millisecond, so this is precisely the
    // case where a non-deterministic tiebreak would show up.
    const events = await repo.events.listByApplicationId(id);
    expect(events.map((event) => event.eventType)).toEqual([
      'STATUS_CHANGED',
      'PAYMENT_VERIFIED',
      'STATUS_CHANGED',
    ]);
  });

  it('keeps the timeline in causal order when a batch shares a millisecond', async () => {
    // The clock is frozen, so every event carries the same created_at and the
    // ordering can only come from insert order.
    const frozen = new Date('2026-08-20T03:00:00.000Z');
    const repo = repository({ now: () => frozen });
    const id = await seedApplication(repo);
    const stateMachine = createStateMachine(repo);

    await stateMachine.transition(id, 'AWAITING_PAYMENT');
    await stateMachine.transition(id, 'PAYMENT_VERIFIED', { domainEvent: 'PAYMENT_VERIFIED' });
    await stateMachine.transition(id, 'SUBMITTED', { domainEvent: 'APPLICATION_SUBMITTED' });

    const events = await repo.events.listByApplicationId(id);
    expect(new Set(events.map((event) => event.createdAt)).size).toBe(1);
    expect(events.map((event) => event.eventType)).toEqual([
      'STATUS_CHANGED',
      'PAYMENT_VERIFIED',
      'STATUS_CHANGED',
      'APPLICATION_SUBMITTED',
      'STATUS_CHANGED',
    ]);
  });

  it('records the true previous status, never a stale one', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stateMachine = machine(repo);

    await stateMachine.transition(id, 'AWAITING_PAYMENT');
    await stateMachine.transition(id, 'PAYMENT_VERIFIED');
    await stateMachine.transition(id, 'SUBMITTED');

    const changes = (await repo.events.listByApplicationId(id))
      .filter((event) => event.eventType === 'STATUS_CHANGED')
      .map((event) => `${String(event.metadata?.['from'])}->${String(event.metadata?.['to'])}`);

    expect(changes).toEqual([
      'DRAFT->AWAITING_PAYMENT',
      'AWAITING_PAYMENT->PAYMENT_VERIFIED',
      'PAYMENT_VERIFIED->SUBMITTED',
    ]);
  });

  it('never writes applicant data into the audit metadata', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    await walkTo(repo, id, 'COMPLETED');

    const events = await repo.events.listByApplicationId(id);
    const serialised = JSON.stringify(events);

    for (const forbidden of ['1234567890121', 'ทดสอบ', 'ระบบสมัคร', 'example.test']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('records no audit event when the transition is refused', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await machine(repo).transition(id, 'COMPLETED');

    await expect(repo.events.listByApplicationId(id)).resolves.toEqual([]);
  });

  it('writes the status and its events in one transaction', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    // Every statement in the batch is guarded on the pre-transition status, so
    // a compare-and-set that does not apply leaves no event behind. Calling the
    // repository with a stale `from` simulates losing the race.
    const applied = await repo.applications.transitionStatus({
      id,
      from: 'SUBMITTED',
      to: 'MANAGER_NOTIFIED',
      events: [
        {
          applicationId: id,
          eventType: 'STATUS_CHANGED',
          actorType: 'SYSTEM',
          metadata: { from: 'SUBMITTED', to: 'MANAGER_NOTIFIED' },
        },
      ],
    });

    expect(applied).toBe(false);
    await expect(repo.applications.findById(id)).resolves.toMatchObject({ status: 'DRAFT' });
    await expect(repo.events.listByApplicationId(id)).resolves.toEqual([]);
  });

  it('refuses a same-status transition at the repository level', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    // A same-status call would satisfy the event guard without changing
    // anything, which would record a transition that never happened.
    await expect(
      repo.applications.transitionStatus({
        id,
        from: 'DRAFT',
        to: 'DRAFT',
        events: [],
      }),
    ).rejects.toThrow(/must change the status/);
  });

  it('never leaves a status change without its audit event', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stateMachine = machine(repo);

    for (const status of HAPPY_PATH) {
      await stateMachine.transition(id, status);
    }

    const changes = (await repo.events.listByApplicationId(id)).filter(
      (event) => event.eventType === 'STATUS_CHANGED',
    );
    expect(changes).toHaveLength(HAPPY_PATH.length);
  });
});

describe('exception paths', () => {
  it('allows cancelling a draft', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await expect(machine(repo).transition(id, 'CANCELLED')).resolves.toMatchObject({
      kind: 'APPLIED',
    });
  });

  it('allows a refund to be requested and settled after payment', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stateMachine = machine(repo);
    await walkTo(repo, id, 'PAYMENT_VERIFIED');

    await expect(stateMachine.transition(id, 'REFUND_REQUIRED')).resolves.toMatchObject({
      kind: 'APPLIED',
    });
    await expect(stateMachine.transition(id, 'REFUNDED')).resolves.toMatchObject({
      kind: 'APPLIED',
    });
  });

  it('refuses any transition out of a terminal status', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stateMachine = machine(repo);
    await walkTo(repo, id, 'COMPLETED');

    for (const status of APPLICATION_STATUSES) {
      const outcome = await stateMachine.transition(id, status);
      expect(outcome.kind).toBe(status === 'COMPLETED' ? 'ALREADY_IN_TARGET_STATE' : 'NOT_ALLOWED');
    }
  });
});
