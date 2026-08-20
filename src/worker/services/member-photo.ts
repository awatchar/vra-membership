import type { PhotoSource, Repository } from '../db';
import { ApiError } from '../lib/http';
import { verifyMemberPhoto } from '../lib/images';
import type { SupportedImageType } from '../lib/files';
import type { AuditLog } from './audit';

/**
 * Member photo storage.
 *
 * This is the only image in the whole system that is kept. The ID card and the
 * payment slip pass through memory and are discarded; the member photo is
 * stored because the association needs it to print a card (Issue #1 section 13).
 *
 * Three rules shape the implementation:
 *
 * 1. **The object key is random and carries nothing.** Not the citizen ID, not
 *    the name, not the callsign. A bucket listing must not be a membership
 *    roster.
 * 2. **Replacing a photo deletes the old object.** Otherwise every retake
 *    leaves an orphaned face in the bucket that nothing references and nobody
 *    will ever delete.
 * 3. **Storing requires an explicit choice.** Using the face from the ID card
 *    without the applicant saying so is exactly what Issue #1 section 61
 *    forbids, so consent is a required input rather than an assumption.
 */

const KEY_PREFIX = 'member-photos/';

const MESSAGES = {
  notFound: 'ไม่พบใบสมัครนี้ กรุณาเริ่มขั้นตอนใหม่',
  consent: 'กรุณายืนยันการเลือกรูปสำหรับบัตรสมาชิกก่อนบันทึก',
  notEditable: 'ใบสมัครนี้อยู่ในขั้นตอนที่ไม่สามารถเปลี่ยนรูปได้แล้ว',
} as const;

/**
 * Statuses in which the photo may still be set or replaced.
 *
 * Once the manager has been notified, the photo may already be in use for a
 * printed card, so changing it silently would leave the card and the record
 * disagreeing.
 */
const EDITABLE_STATUSES = ['DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_VERIFIED', 'SUBMITTED'] as const;

export interface StoreMemberPhotoInput {
  applicationId: string;
  source: PhotoSource;
  /** The applicant's explicit confirmation of this photo (Issue #1 section 12). */
  confirmed: boolean;
  bytes: Uint8Array;
  contentType: SupportedImageType;
}

export interface StoredMemberPhoto {
  key: string;
  source: PhotoSource;
  width: number;
  height: number;
  byteLength: number;
  /** True when EXIF or similar metadata was present and removed. */
  metadataStripped: boolean;
  /** True when this replaced an earlier photo, whose object was deleted. */
  replacedPrevious: boolean;
}

export interface MemberPhotoService {
  store(input: StoreMemberPhotoInput): Promise<StoredMemberPhoto>;
  /** Reads a stored photo. Callers must have authenticated the requester. */
  read(applicationId: string): Promise<{ body: ReadableStream; contentType: string } | null>;
}

export interface MemberPhotoOptions {
  now?: () => Date;
  newKey?: () => string;
}

export function createMemberPhotoService(
  db: Repository,
  bucket: R2Bucket,
  audit: AuditLog,
  options: MemberPhotoOptions = {},
): MemberPhotoService {
  const now = options.now ?? (() => new Date());
  // A UUID and nothing else: the key must reveal nothing about whose face it is.
  const newKey = options.newKey ?? (() => `${KEY_PREFIX}${crypto.randomUUID()}.jpg`);

  return {
    async store(input) {
      if (!input.confirmed) {
        throw new ApiError('VALIDATION_FAILED', MESSAGES.consent);
      }

      const application = await db.applications.findById(input.applicationId);
      if (!application) {
        throw new ApiError('NOT_FOUND', MESSAGES.notFound);
      }

      if (!EDITABLE_STATUSES.includes(application.status as (typeof EDITABLE_STATUSES)[number])) {
        throw new ApiError('CONFLICT', MESSAGES.notEditable);
      }

      const verified = verifyMemberPhoto(input.bytes, input.contentType);
      const key = newKey();
      const uploadedAt = now().toISOString();

      await bucket.put(key, verified.bytes as ArrayBufferView, {
        httpMetadata: { contentType: verified.contentType },
        // Deliberately no customMetadata: R2 metadata is another place personal
        // data could accumulate, and the database already holds the link.
      });

      await db.applications.setPhoto(input.applicationId, {
        key,
        source: input.source,
        uploadedAt,
      });

      // The old object is deleted after the new one is recorded. In the reverse
      // order a failure between the two steps would leave the application
      // pointing at an object that no longer exists.
      const previousKey = application.photoKey;
      let replacedPrevious = false;
      if (previousKey && previousKey !== key) {
        await bucket.delete(previousKey);
        replacedPrevious = true;
      }

      await audit.record({
        applicationId: input.applicationId,
        eventType: 'PHOTO_SELECTED',
        actorType: 'APPLICANT',
        // `source` is an enum value. The key is not recorded: it is the one
        // string that points at a person's face.
        metadata: { source: input.source },
      });

      return {
        key,
        source: input.source,
        width: verified.dimensions.width,
        height: verified.dimensions.height,
        byteLength: verified.bytes.byteLength,
        metadataStripped: verified.metadataStripped,
        replacedPrevious,
      };
    },

    async read(applicationId) {
      const application = await db.applications.findById(applicationId);
      if (!application?.photoKey) return null;

      const object = await bucket.get(application.photoKey);
      if (!object) return null;

      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      };
    },
  };
}
