import type { Repository } from '../db';
import { requireSecret } from '../env';
import type { WorkerEnv } from '../env';
import { createCitizenIdProtection } from '../lib/crypto';
import type { EmailProvider } from '../providers/types';
import { createAuditLog } from './audit';
import { createEmailService } from './email';
import { createApplicationWorkflow } from './application-workflow';
import type { ApplicationWorkflow } from './application-workflow';
import { createNumberingService } from './numbering';
import { createReceiptService } from './receipt';
import { createStateMachine } from './state-machine';

/**
 * Assembly for the post-payment workflow.
 *
 * The workflow needs numbering, the receipt service, the email service and the
 * state machine, and the email service in turn needs the receipt service and
 * the citizen ID key. Two routes construct all of that - the one that verifies a
 * payment and the one that reports or resumes the result - and building it twice
 * by hand is how the two end up differing in a way nothing catches.
 */
export async function buildApplicationWorkflow(
  env: WorkerEnv,
  db: Repository,
  emailProvider: EmailProvider,
  appBaseUrl: string,
): Promise<ApplicationWorkflow> {
  const audit = createAuditLog(db);
  const numbering = createNumberingService(db);
  const receipts = createReceiptService(db, numbering, audit);

  const emails = createEmailService(db, emailProvider, receipts, audit, {
    managerEmail: requireSecret(env, 'MANAGER_EMAIL'),
    ccEmail: requireSecret(env, 'EMAIL_CC'),
    appBaseUrl,
    // Only the manager notification uses this, to show four digits of the
    // citizen ID; see docs/decisions/0002-citizen-id-not-in-email.md.
    citizenId: await createCitizenIdProtection(requireSecret(env, 'PII_ENCRYPTION_KEY')),
  });

  return createApplicationWorkflow(db, createStateMachine(db), numbering, receipts, emails);
}
