import type {
  AddressInput,
  ApplicationRecord,
  ApplicationStatus,
  MembershipType,
  Repository,
} from '../db';
import { UniqueConstraintError } from '../db';
import { isValidCitizenId, normalizeCitizenId } from '../lib/citizen-id';
import type { CitizenIdProtection } from '../lib/crypto';
import { ApiError } from '../lib/http';
import type { AuditLog } from './audit';
import { generateAccessToken } from './application-access';
import type { ApplicationAccess } from './application-access';
import { membershipPlan } from './membership';

/**
 * Application lifecycle up to payment.
 *
 * The applicant reviews what OCR produced, corrects it, adds contact details
 * and an address, and picks a membership type. Only then does a row exist: an
 * abandoned OCR attempt leaves nothing behind (Issue #1 section 6).
 */

const MESSAGES = {
  citizenId: 'เลขบัตรประชาชนไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง',
  notFound: 'ไม่พบใบสมัครนี้ กรุณาเริ่มขั้นตอนใหม่',
  notEditable: 'ใบสมัครนี้อยู่ในขั้นตอนที่ไม่สามารถแก้ไขข้อมูลได้แล้ว',
  mailPostcode: 'กรุณากรอกรหัสไปรษณีย์สำหรับที่อยู่จัดส่งเอกสาร',
  mailRecipient: 'กรุณากรอกชื่อผู้รับและที่อยู่สำหรับจัดส่งเอกสาร',
} as const;

/** Statuses in which the applicant may still change their own data. */
const EDITABLE_STATUSES: readonly ApplicationStatus[] = ['DRAFT', 'AWAITING_PAYMENT'];

export interface CreateApplicationInput {
  citizenId: string;
  // `| undefined` is explicit because `exactOptionalPropertyTypes` treats an
  // absent property and one set to undefined as different, and a parsed zod
  // payload produces the latter.
  title?: string | null | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  firstNameEn?: string | null | undefined;
  lastNameEn?: string | null | undefined;
  birthDate?: string | null | undefined;
  cardExpiryDate?: string | null | undefined;
}

export interface UpdateApplicationInput {
  phone?: string | null | undefined;
  email?: string | null | undefined;
  callsign?: string | null | undefined;
  membershipType?: MembershipType | undefined;
  address?: ApplicantAddressInput | undefined;
}

/**
 * The two-address model (Issue #1 section 9).
 *
 * `mailSameAsId` copies the ID-card address but still requires a postcode,
 * because a Thai ID card does not print one and nothing may infer it.
 */
export interface ApplicantAddressInput {
  idAddress?: string | null | undefined;
  idSubdistrict?: string | null | undefined;
  idDistrict?: string | null | undefined;
  idProvince?: string | null | undefined;
  mailSameAsId: boolean;
  mailRecipient?: string | null | undefined;
  mailAddress?: string | null | undefined;
  mailSubdistrict?: string | null | undefined;
  mailDistrict?: string | null | undefined;
  mailProvince?: string | null | undefined;
  mailPostcode: string;
  mailPhone?: string | null | undefined;
}

/** What the applicant is allowed to see back. Never the full citizen ID. */
export interface ApplicationView {
  id: string;
  referenceNo: string | null;
  status: ApplicationStatus;
  /** Last four digits only, so the applicant can confirm which card they used. */
  citizenIdTail: string;
  title: string | null;
  firstName: string | null;
  lastName: string | null;
  firstNameEn: string | null;
  lastNameEn: string | null;
  birthDate: string | null;
  cardExpiryDate: string | null;
  phone: string | null;
  email: string | null;
  callsign: string | null;
  membershipType: MembershipType | null;
  membershipAmountSatang: number | null;
  hasPhoto: boolean;
  photoSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedApplication {
  view: ApplicationView;
  /**
   * The capability token, returned exactly once. Never stored in clear text and
   * never retrievable again.
   */
  accessToken: string;
  /** Ids of earlier applications by the same person, if any. */
  previousApplicationIds: readonly string[];
}

export interface ApplicationService {
  create(input: CreateApplicationInput): Promise<CreatedApplication>;
  get(applicationId: string): Promise<ApplicationView>;
  update(applicationId: string, input: UpdateApplicationInput): Promise<ApplicationView>;
}

/**
 * Projects a record into what the applicant may see.
 *
 * `citizenIdTail` is a required argument rather than something the caller
 * patches in afterwards: a default of `''` would let a forgotten override ship
 * a view that silently shows no card digits at all.
 */
export function toApplicationView(
  record: ApplicationRecord,
  citizenIdTail: string,
): ApplicationView {
  return {
    id: record.id,
    referenceNo: record.referenceNo,
    status: record.status,
    // Four digits are enough for the applicant to confirm the right card
    // without echoing the whole number back over the wire.
    citizenIdTail,
    title: record.title,
    firstName: record.firstName,
    lastName: record.lastName,
    firstNameEn: record.firstNameEn,
    lastNameEn: record.lastNameEn,
    birthDate: record.birthDate,
    cardExpiryDate: record.cardExpiryDate,
    phone: record.phone,
    email: record.email,
    callsign: record.callsign,
    membershipType: record.membershipType,
    membershipAmountSatang: record.membershipAmountSatang,
    hasPhoto: record.photoKey !== null,
    photoSource: record.photoSource,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Rejects an address that cannot be posted to. */
function validateAddress(address: ApplicantAddressInput): void {
  // Required in both modes. The ID card carries no postcode, so copying the
  // card address still leaves it unknown (Issue #1 section 9.2).
  if (!/^\d{5}$/.test(address.mailPostcode)) {
    throw new ApiError('VALIDATION_FAILED', MESSAGES.mailPostcode);
  }

  if (!address.mailSameAsId) {
    const required = [
      address.mailRecipient,
      address.mailAddress,
      address.mailSubdistrict,
      address.mailDistrict,
      address.mailProvince,
    ];
    if (required.some((value) => !value || value.trim().length === 0)) {
      throw new ApiError('VALIDATION_FAILED', MESSAGES.mailRecipient);
    }
  }
}

function toAddressRow(address: ApplicantAddressInput): AddressInput {
  const sameAsId = address.mailSameAsId;
  return {
    idAddress: address.idAddress ?? null,
    idSubdistrict: address.idSubdistrict ?? null,
    idDistrict: address.idDistrict ?? null,
    idProvince: address.idProvince ?? null,
    mailSameAsId: sameAsId,
    // When copying, the mailing fields mirror the card fields so the manager
    // can read one address without resolving a flag first.
    mailRecipient: sameAsId ? null : (address.mailRecipient ?? null),
    mailAddress: sameAsId ? (address.idAddress ?? null) : (address.mailAddress ?? null),
    mailSubdistrict: sameAsId ? (address.idSubdistrict ?? null) : (address.mailSubdistrict ?? null),
    mailDistrict: sameAsId ? (address.idDistrict ?? null) : (address.mailDistrict ?? null),
    mailProvince: sameAsId ? (address.idProvince ?? null) : (address.mailProvince ?? null),
    mailPostcode: address.mailPostcode,
    mailPhone: address.mailPhone ?? null,
  };
}

export function createApplicationService(
  db: Repository,
  protection: CitizenIdProtection,
  access: ApplicationAccess,
  audit: AuditLog,
): ApplicationService {
  const requireEditable = async (applicationId: string): Promise<ApplicationRecord> => {
    const record = await db.applications.findById(applicationId);
    if (!record) {
      throw new ApiError('NOT_FOUND', MESSAGES.notFound);
    }
    if (!EDITABLE_STATUSES.includes(record.status)) {
      throw new ApiError('CONFLICT', MESSAGES.notEditable);
    }
    return record;
  };

  return {
    async create(input) {
      const citizenId = normalizeCitizenId(input.citizenId);
      // The check digit is verified because every real card satisfies it, so a
      // failure means a misread or a typo the applicant can still fix.
      if (!isValidCitizenId(citizenId)) {
        throw new ApiError('VALIDATION_FAILED', MESSAGES.citizenId);
      }

      const citizenIdHash = await protection.hash(citizenId);
      const previousApplicationIds = await db.applications.findIdsByCitizenIdHash(citizenIdHash);

      const accessToken = generateAccessToken();
      const record = await db.applications.create({
        citizenIdHash,
        citizenIdCiphertext: await protection.encrypt(citizenId),
        accessTokenHash: await access.hash(accessToken),
        title: input.title ?? null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        firstNameEn: input.firstNameEn ?? null,
        lastNameEn: input.lastNameEn ?? null,
        birthDate: input.birthDate ?? null,
        cardExpiryDate: input.cardExpiryDate ?? null,
      });

      await audit.record({
        applicationId: record.id,
        eventType: 'APPLICATION_CREATED',
        actorType: 'APPLICANT',
        // A count, not the ids: how many previous applications exist is useful
        // context, and which ones is not this event's business.
        metadata: { count: previousApplicationIds.length },
      });

      return {
        view: toApplicationView(record, citizenId.slice(-4)),
        accessToken,
        previousApplicationIds,
      };
    },

    async get(applicationId) {
      const record = await db.applications.findById(applicationId);
      if (!record) {
        throw new ApiError('NOT_FOUND', MESSAGES.notFound);
      }

      // Decrypting only to show four digits is deliberate: the alternative is
      // storing the tail separately, which means storing part of the number in
      // clear text forever.
      const citizenId = await protection.decrypt(record.citizenIdCiphertext);
      return toApplicationView(record, citizenId.slice(-4));
    },

    async update(applicationId, input) {
      await requireEditable(applicationId);

      if (input.phone !== undefined || input.email !== undefined || input.callsign !== undefined) {
        await db.applications.updateContact(applicationId, {
          phone: input.phone ?? null,
          email: input.email ?? null,
          callsign: input.callsign ?? null,
        });
      }

      if (input.membershipType) {
        // Resolved from the catalogue. An amount from the client is not read at
        // all, so there is nothing to ignore.
        const plan = membershipPlan(input.membershipType);
        await db.applications.setMembership(applicationId, plan.type, plan.amountSatang);
        await audit.record({
          applicationId,
          eventType: 'MEMBERSHIP_SELECTED',
          actorType: 'APPLICANT',
          metadata: { membershipType: plan.type, amountSatang: plan.amountSatang },
        });
      }

      if (input.address) {
        validateAddress(input.address);
        try {
          await db.addresses.upsert(applicationId, toAddressRow(input.address));
        } catch (error) {
          // A CHECK violation here means a value the schema rejects, e.g. a
          // malformed postcode that slipped past validation.
          if (error instanceof UniqueConstraintError) throw error;
          throw new ApiError('VALIDATION_FAILED', MESSAGES.mailPostcode, { cause: error });
        }
      }

      return this.get(applicationId);
    },
  };
}
