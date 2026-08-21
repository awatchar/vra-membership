import type {
  AddressRecord,
  ApplicationEventRecord,
  ApplicationListQuery,
  ApplicationRecord,
  ApplicationStatus,
  MembershipType,
  PaymentRecord,
  ReceiptRecord,
  Repository,
} from '../db';
import type { CitizenIdProtection } from '../lib/crypto';
import { ApiError } from '../lib/http';
import type { AuditLog } from './audit';
import type { ApplicationWorkflow, WorkflowReport } from './application-workflow';
import { formatBaht, membershipPlan } from './membership';

/**
 * What the manager sees (Issue #1 sections 52-53).
 *
 * This module exists so that reading an application's full details is one code
 * path with the audit event attached to it. The citizen ID is decrypted here and
 * nowhere else in the admin flow, and `CITIZEN_ID_ACCESSED` is recorded on the
 * same call - so there is no way to add a second reader later that forgets to
 * record it.
 *
 * The list view carries no personal data beyond a name. A manager scanning a
 * queue does not need addresses or contact details, and a list endpoint is the
 * one most likely to be logged, cached or screenshotted.
 */

export const CITIZEN_ID_ACCESSED_EVENT = 'CITIZEN_ID_ACCESSED';

/**
 * Thrown for an unknown application.
 *
 * An `ApiError` rather than a bespoke class so the entrypoint maps it to 404
 * without a per-service branch - a custom error here surfaced as a 500 and told
 * the caller nothing.
 */
export function adminApplicationNotFound(): ApiError {
  return new ApiError('NOT_FOUND', 'ไม่พบใบสมัครนี้');
}

export interface AdminListItem {
  id: string;
  referenceNo: string | null;
  status: ApplicationStatus;
  name: string | null;
  membershipType: MembershipType | null;
  amountBaht: string | null;
  submittedAt: string | null;
  createdAt: string;
}

export interface AdminDetail {
  application: {
    id: string;
    referenceNo: string | null;
    status: ApplicationStatus;
    title: string | null;
    firstName: string | null;
    lastName: string | null;
    firstNameEn: string | null;
    lastNameEn: string | null;
    birthDate: string | null;
    cardExpiryDate: string | null;
    /** Full number. Decrypted for this call only, and audited. */
    citizenId: string | null;
    phone: string | null;
    email: string | null;
    callsign: string | null;
    membershipType: MembershipType | null;
    membershipLabel: string | null;
    amountBaht: string | null;
    hasPhoto: boolean;
    photoSource: string | null;
    submittedAt: string | null;
    managerAcknowledgedAt: string | null;
    nbtcRecordedAt: string | null;
    nbtcRecordedBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
  address: AddressRecord | null;
  payment: {
    transactionRef: string;
    amountBaht: string;
    sendingBank: string | null;
    receivingBank: string | null;
    transactionAt: string | null;
    verifiedAt: string | null;
  } | null;
  receipt: { receiptNo: string; amountBaht: string; issuedAt: string } | null;
  /** Which post-payment steps have happened, without attempting any of them. */
  workflow: WorkflowReport;
  events: ApplicationEventRecord[];
}

export interface AdminViewService {
  list(query?: ApplicationListQuery): Promise<AdminListItem[]>;
  /**
   * The full record, decrypting the citizen ID and recording that it was read.
   *
   * `actor` is the manager's Access identity, so the trail says who looked.
   */
  detail(applicationId: string, actor: string): Promise<AdminDetail>;
}

function fullName(record: ApplicationRecord): string | null {
  const name = [record.title, record.firstName, record.lastName]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join(' ');
  return name.length > 0 ? name : null;
}

function latestVerified(payments: readonly PaymentRecord[]): PaymentRecord | null {
  return payments.filter((payment) => payment.verificationStatus === 'VERIFIED').at(-1) ?? null;
}

function receiptView(receipt: ReceiptRecord | null): AdminDetail['receipt'] {
  if (!receipt) return null;
  return {
    receiptNo: receipt.receiptNo,
    amountBaht: formatBaht(receipt.amountSatang),
    issuedAt: receipt.issuedAt,
  };
}

export function createAdminView(
  db: Repository,
  citizenId: CitizenIdProtection,
  workflow: ApplicationWorkflow,
  audit: AuditLog,
): AdminViewService {
  return {
    async list(query) {
      const records = await db.applications.list(query);
      return records.map((record) => ({
        id: record.id,
        referenceNo: record.referenceNo,
        status: record.status,
        name: fullName(record),
        membershipType: record.membershipType,
        amountBaht:
          record.membershipAmountSatang === null ? null : formatBaht(record.membershipAmountSatang),
        submittedAt: record.submittedAt,
        createdAt: record.createdAt,
      }));
    },

    async detail(applicationId, actor) {
      const application = await db.applications.findById(applicationId);
      if (!application) throw adminApplicationNotFound();

      const [address, payments, receipt, events, report] = await Promise.all([
        db.addresses.findByApplicationId(applicationId),
        db.payments.findByApplicationId(applicationId),
        db.receipts.findByApplicationId(applicationId),
        db.events.listByApplicationId(applicationId),
        workflow.inspect(applicationId),
      ]);

      // Decrypting is the sensitive act, so it is recorded before the value is
      // used. An envelope that cannot be read leaves the field null rather than
      // failing the page: the manager still needs everything else.
      let plainCitizenId: string | null;
      try {
        plainCitizenId = await citizenId.decrypt(application.citizenIdCiphertext);
        await audit.record({
          applicationId,
          eventType: CITIZEN_ID_ACCESSED_EVENT,
          actorType: 'MANAGER',
          actorId: actor,
        });
      } catch {
        plainCitizenId = null;
      }

      const payment = latestVerified(payments);
      const plan = application.membershipType ? membershipPlan(application.membershipType) : null;

      return {
        application: {
          id: application.id,
          referenceNo: application.referenceNo,
          status: application.status,
          title: application.title,
          firstName: application.firstName,
          lastName: application.lastName,
          firstNameEn: application.firstNameEn,
          lastNameEn: application.lastNameEn,
          birthDate: application.birthDate,
          cardExpiryDate: application.cardExpiryDate,
          citizenId: plainCitizenId,
          phone: application.phone,
          email: application.email,
          callsign: application.callsign,
          membershipType: application.membershipType,
          membershipLabel: plan?.labelTh ?? null,
          amountBaht:
            application.membershipAmountSatang === null
              ? null
              : formatBaht(application.membershipAmountSatang),
          hasPhoto: application.photoKey !== null,
          photoSource: application.photoSource,
          submittedAt: application.submittedAt,
          managerAcknowledgedAt: application.managerAcknowledgedAt,
          nbtcRecordedAt: application.nbtcRecordedAt,
          nbtcRecordedBy: application.nbtcRecordedBy,
          createdAt: application.createdAt,
          updatedAt: application.updatedAt,
        },
        address,
        payment: payment
          ? {
              transactionRef: payment.transactionRef,
              amountBaht: formatBaht(payment.amountSatang),
              sendingBank: payment.sendingBank,
              receivingBank: payment.receivingBank,
              transactionAt: payment.transactionAt,
              verifiedAt: payment.verifiedAt,
            }
          : null,
        receipt: receiptView(receipt),
        workflow: report,
        events,
      };
    },
  };
}
