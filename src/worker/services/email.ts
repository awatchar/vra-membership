import type {
  AddressRecord,
  ApplicationRecord,
  EmailRecord,
  EmailType,
  PaymentRecord,
  ReceiptRecord,
  Repository,
} from '../db';
import {
  displayName,
  managerNewApplicationEmail,
  maskCitizenId,
  memberCompletedEmail,
  memberProcessingEmail,
  receiptEmail,
} from '../emails';
import type { RenderedEmail } from '../emails';
import type { CitizenIdProtection } from '../lib/crypto';
import { formatThaiDate, formatThaiDateTime } from '../lib/time';
import type {
  EmailAttachment,
  EmailFailureReason,
  EmailProvider,
  OutboundEmail,
} from '../providers/types';
import type { AuditLog } from './audit';
import { formatBaht, membershipPlan } from './membership';
import type { ReceiptService } from './receipt';

/**
 * Transactional email (Issue #1 sections 27, 30-32, 35, 40, 54-55).
 *
 * The rule this module exists to enforce: **a failed email never fails the
 * thing it was reporting on.** By the time the receipt email is sent the
 * association has the money and the receipt number is issued; if Resend is
 * down, all of that has to remain true. So a send records its own outcome and
 * returns it, and the only thing that throws is being asked about an
 * application or a row that does not exist - a programming error, not an
 * operational one.
 *
 * The row is written before the provider is called, so a send whose outcome was
 * never learned still leaves something to retry from and something for a
 * delivery webhook to be matched against. `retry` reuses that row, and with it
 * the provider idempotency key, so retrying a timeout cannot deliver a second
 * copy to the member.
 */

export class EmailApplicationNotFoundError extends Error {
  constructor() {
    super('ไม่พบใบสมัครนี้');
    this.name = 'EmailApplicationNotFoundError';
  }
}

export class EmailRecordNotFoundError extends Error {
  constructor() {
    super('ไม่พบรายการอีเมลนี้');
    this.name = 'EmailRecordNotFoundError';
  }
}

/** Why a send produced nothing, without the provider being involved. */
export type EmailSkipReason = 'NO_RECIPIENT' | 'NOT_ELIGIBLE';

export type EmailOutcome =
  | { ok: true; emailId: string; providerEmailId: string }
  | { ok: false; emailId: string; reason: EmailFailureReason }
  | { ok: false; emailId: null; reason: EmailSkipReason };

export interface EmailService {
  /** Payment verified: receipt PDF to the member (section 27). */
  sendReceipt(applicationId: string): Promise<EmailOutcome>;
  /** New application: operational summary to the manager (sections 30-32). */
  sendManagerNewApplication(applicationId: string): Promise<EmailOutcome>;
  /** Manager has picked it up: notice to the member (section 35). */
  sendMemberProcessing(applicationId: string): Promise<EmailOutcome>;
  /** Registration recorded: completion notice to the member (section 40). */
  sendMemberCompleted(applicationId: string): Promise<EmailOutcome>;
  /** Re-sends an existing row, keeping its provider idempotency key. */
  retry(emailId: string): Promise<EmailOutcome>;
}

export interface EmailServiceOptions {
  /** Manager recipient, from configuration; never a hard-coded address. */
  managerEmail: string;
  /** Origin of the admin portal, used to build the manager's links. */
  appBaseUrl: string;
  /**
   * Needed only to show the manager the last four digits of a citizen ID.
   * Omit it and that row is left out of the email entirely.
   */
  citizenId?: CitizenIdProtection;
  now?: () => Date;
}

/** Everything a template might need, read once per send. */
interface ApplicationContext {
  application: ApplicationRecord;
  address: AddressRecord | null;
  payment: PaymentRecord | null;
  receipt: ReceiptRecord | null;
}

/** What a send needs after the type has been resolved against the record. */
interface Prepared {
  recipient: string;
  rendered: RenderedEmail;
  extras: Pick<OutboundEmail, 'attachments' | 'trackOpens'>;
}

function membershipLabel(application: ApplicationRecord): string {
  return application.membershipType
    ? membershipPlan(application.membershipType).labelTh
    : 'ไม่ระบุประเภทสมาชิก';
}

/** The reference number, or a readable stand-in if one has not been issued. */
function reference(application: ApplicationRecord): string {
  return application.referenceNo ?? 'ยังไม่ออกเลขที่ใบสมัคร';
}

function verifiedPayment(payments: readonly PaymentRecord[]): PaymentRecord | null {
  return payments.filter((payment) => payment.verificationStatus === 'VERIFIED').at(-1) ?? null;
}

/** Address as printed on the ID card, on one line. */
function idAddressLine(address: AddressRecord | null): string | null {
  if (!address) return null;
  const parts = [address.idAddress, address.idSubdistrict, address.idDistrict, address.idProvince]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(' ') : null;
}

function instantLabel(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : formatThaiDateTime(parsed);
}

/** A stored `YYYY-MM-DD` is a Bangkok calendar date, not an instant. */
function dateLabel(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00+07:00`);
  return Number.isNaN(parsed.getTime()) ? null : formatThaiDate(parsed);
}

function englishName(application: ApplicationRecord): string | null {
  const name = [application.firstNameEn, application.lastNameEn]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join(' ');
  return name.length > 0 ? name : null;
}

export function createEmailService(
  db: Repository,
  provider: EmailProvider,
  receipts: ReceiptService,
  audit: AuditLog,
  options: EmailServiceOptions,
): EmailService {
  const now = options.now ?? (() => new Date());
  const portal = options.appBaseUrl.replace(/\/+$/, '');

  const load = async (applicationId: string): Promise<ApplicationContext> => {
    const application = await db.applications.findById(applicationId);
    if (!application) throw new EmailApplicationNotFoundError();

    const [address, payments, receipt] = await Promise.all([
      db.addresses.findByApplicationId(applicationId),
      db.payments.findByApplicationId(applicationId),
      db.receipts.findByApplicationId(applicationId),
    ]);

    return { application, address, payment: verifiedPayment(payments), receipt };
  };

  /**
   * Decrypts the citizen ID only to mask it, and audits the read.
   *
   * The manager needs enough digits to match a person against their own records;
   * the full number is on the application detail page, where reading it is
   * authenticated. Auditing here too means the trail has no hole where an email
   * was sent, and an unreadable envelope leaves the row out rather than stopping
   * the manager being told there is an application waiting.
   */
  const maskedCitizenId = async (application: ApplicationRecord): Promise<string> => {
    if (!options.citizenId) return '';
    try {
      const masked = maskCitizenId(
        await options.citizenId.decrypt(application.citizenIdCiphertext),
      );
      await audit.record({
        applicationId: application.id,
        eventType: 'CITIZEN_ID_MASKED_FOR_EMAIL',
        actorType: 'SYSTEM',
        metadata: { emailType: 'MANAGER_NEW_APPLICATION' },
      });
      return masked;
    } catch {
      return '';
    }
  };

  const receiptAttachment = async (applicationId: string): Promise<EmailAttachment[]> => {
    const { bytes, filename } = await receipts.render(applicationId);
    return [{ filename, contentType: 'application/pdf', content: bytes }];
  };

  /**
   * Resolves one email type against the record, or null when the record does
   * not support it - a receipt email with no receipt, for instance.
   */
  const prepare = async (
    type: EmailType,
    context: ApplicationContext,
  ): Promise<Prepared | null> => {
    const { application, address, payment, receipt } = context;
    const recipientName = displayName(application);
    const memberAddress = application.email?.trim() ?? '';

    switch (type) {
      case 'RECEIPT': {
        if (memberAddress.length === 0 || !receipt) return null;
        return {
          recipient: memberAddress,
          rendered: receiptEmail({
            recipientName,
            applicationReferenceNo: reference(application),
            membershipLabel: membershipLabel(application),
            amountBaht: formatBaht(receipt.amountSatang),
            receiptNo: receipt.receiptNo,
            paidAtLabel: instantLabel(payment?.transactionAt ?? null),
          }),
          extras: { attachments: await receiptAttachment(application.id) },
        };
      }

      case 'MEMBER_PROCESSING': {
        if (memberAddress.length === 0) return null;
        return {
          recipient: memberAddress,
          rendered: memberProcessingEmail({
            recipientName,
            applicationReferenceNo: reference(application),
          }),
          extras: {},
        };
      }

      case 'MEMBER_NBTC_COMPLETED': {
        if (memberAddress.length === 0) return null;
        return {
          recipient: memberAddress,
          rendered: memberCompletedEmail({
            recipientName,
            applicationReferenceNo: reference(application),
            membershipLabel: membershipLabel(application),
            recordedAtLabel: instantLabel(application.nbtcRecordedAt),
          }),
          extras: {},
        };
      }

      case 'MANAGER_NEW_APPLICATION': {
        return {
          recipient: options.managerEmail,
          rendered: managerNewApplicationEmail({
            applicantName: recipientName,
            applicantNameEn: englishName(application),
            applicationReferenceNo: reference(application),
            membershipLabel: membershipLabel(application),
            maskedCitizenId: await maskedCitizenId(application),
            birthDateLabel: dateLabel(application.birthDate),
            idAddress: idAddressLine(address),
            email: application.email,
            phone: application.phone,
            callsign: application.callsign,
            amountBaht: payment ? formatBaht(payment.amountSatang) : null,
            transactionRef: payment?.transactionRef ?? null,
            paidAtLabel: instantLabel(payment?.transactionAt ?? null),
            detailUrl: `${portal}/admin/applications/${application.id}`,
            acknowledgeUrl: `${portal}/admin/applications/${application.id}/acknowledge`,
            nbtcCompleteUrl: `${portal}/admin/applications/${application.id}/nbtc-complete`,
          }),
          // Open tracking is asked for here and nowhere else (section 33).
          extras: { trackOpens: true },
        };
      }
    }
  };

  const dispatch = async (record: EmailRecord, prepared: Prepared): Promise<EmailOutcome> => {
    const result = await provider.send({
      to: prepared.recipient,
      subject: prepared.rendered.subject,
      html: prepared.rendered.html,
      text: prepared.rendered.text,
      // The row id, so retrying an unknown outcome is deduplicated by the
      // provider instead of delivering a second copy.
      idempotencyKey: record.id,
      tags: { applicationId: record.applicationId, emailType: record.type },
      ...prepared.extras,
    });

    if (!result.ok) {
      await db.emails.markFailed(record.id);
      await audit.record({
        applicationId: record.applicationId,
        eventType: 'EMAIL_SEND_FAILED',
        actorType: 'SYSTEM',
        metadata: { emailType: record.type, provider: provider.name, reason: result.reason },
      });
      return { ok: false, emailId: record.id, reason: result.reason };
    }

    await db.emails.markSent(record.id, result.providerEmailId, now().toISOString());
    await audit.record({
      applicationId: record.applicationId,
      eventType: 'EMAIL_SENT',
      actorType: 'SYSTEM',
      metadata: { emailType: record.type, provider: provider.name },
    });
    return { ok: true, emailId: record.id, providerEmailId: result.providerEmailId };
  };

  /** Records that nothing was sent, and why. No row is created. */
  const skip = async (
    applicationId: string,
    type: EmailType,
    reason: EmailSkipReason,
  ): Promise<EmailOutcome> => {
    await audit.record({
      applicationId,
      eventType: 'EMAIL_SKIPPED',
      actorType: 'SYSTEM',
      metadata: { emailType: type, reason },
    });
    return { ok: false, emailId: null, reason };
  };

  const sendType = async (applicationId: string, type: EmailType): Promise<EmailOutcome> => {
    const context = await load(applicationId);
    const prepared = await prepare(type, context);
    if (!prepared) {
      const reason: EmailSkipReason =
        (context.application.email?.trim() ?? '').length === 0 ? 'NO_RECIPIENT' : 'NOT_ELIGIBLE';
      return skip(applicationId, type, reason);
    }

    const record = await db.emails.create({
      applicationId,
      type,
      recipient: prepared.recipient,
      provider: provider.name,
    });
    return dispatch(record, prepared);
  };

  return {
    sendReceipt(applicationId) {
      return sendType(applicationId, 'RECEIPT');
    },

    sendManagerNewApplication(applicationId) {
      return sendType(applicationId, 'MANAGER_NEW_APPLICATION');
    },

    sendMemberProcessing(applicationId) {
      return sendType(applicationId, 'MEMBER_PROCESSING');
    },

    sendMemberCompleted(applicationId) {
      return sendType(applicationId, 'MEMBER_NBTC_COMPLETED');
    },

    async retry(emailId) {
      const record = await db.emails.findById(emailId);
      if (!record) throw new EmailRecordNotFoundError();

      const context = await load(record.applicationId);
      const prepared = await prepare(record.type, context);
      if (!prepared) return skip(record.applicationId, record.type, 'NOT_ELIGIBLE');

      // The stored recipient wins: re-resolving it could send the retry
      // somewhere the first attempt did not go.
      return dispatch(record, { ...prepared, recipient: record.recipient });
    },
  };
}
