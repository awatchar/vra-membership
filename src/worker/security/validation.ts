import type { z } from 'zod';
import { ApiError } from '../lib/http';

/**
 * Request-body validation.
 *
 * Two properties matter beyond "is this the right shape":
 *
 * 1. **Unknown fields are rejected, not stripped.** A client that sends
 *    `amount` alongside `membershipType` has misunderstood the contract, and
 *    silently dropping the field hides that. Rejecting also means a future
 *    field cannot be smuggled past a schema that has not been updated.
 * 2. **No submitted value ever appears in the response.** Zod's default
 *    messages quote what was received, and what was received here is a citizen
 *    ID, an address or an email. Only the field path and a generic Thai message
 *    per failure kind travel back to the client.
 */

/** Applicant-safe messages, keyed by the kind of failure. */
const MESSAGE_BY_CODE: Record<string, string> = {
  invalid_type: 'รูปแบบข้อมูลไม่ถูกต้อง',
  too_small: 'ข้อมูลสั้นเกินกำหนด',
  too_big: 'ข้อมูลยาวเกินกำหนด',
  invalid_format: 'รูปแบบข้อมูลไม่ถูกต้อง',
  invalid_value: 'ค่าที่เลือกไม่ถูกต้อง',
  unrecognized_keys: 'มีข้อมูลที่ระบบไม่รู้จัก',
  invalid_union: 'รูปแบบข้อมูลไม่ถูกต้อง',
  custom: 'ข้อมูลไม่ถูกต้อง',
};

const FALLBACK_MESSAGE = 'ข้อมูลไม่ถูกต้อง';
const BODY_MESSAGE = 'ข้อมูลที่ส่งมาไม่ถูกต้อง กรุณาตรวจสอบและลองอีกครั้ง';
const JSON_MESSAGE = 'ไม่สามารถอ่านข้อมูลที่ส่งมาได้';

export interface FieldError {
  /** Dotted path of the offending field, e.g. `mailAddress.postcode`. */
  field: string;
  message: string;
}

/** Thrown when a body fails validation. Carries paths and messages only. */
export class ValidationError extends ApiError {
  readonly fields: readonly FieldError[];

  constructor(fields: readonly FieldError[]) {
    super('VALIDATION_FAILED', BODY_MESSAGE);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

/** Maps zod issues to field errors, discarding every received value. */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  const seen = new Set<string>();
  const fields: FieldError[] = [];

  for (const issue of error.issues) {
    const field = issue.path.map(String).join('.') || '(body)';
    if (seen.has(field)) continue;
    seen.add(field);
    fields.push({ field, message: MESSAGE_BY_CODE[issue.code] ?? FALLBACK_MESSAGE });
  }

  return fields;
}

/**
 * Parses `value` against `schema`.
 *
 * The schema is expected to be strict about unknown keys; `parseBody` below
 * enforces that for object schemas so a caller cannot forget.
 */
export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(toFieldErrors(result.error));
  }
  return result.data;
}

/**
 * Reads a JSON body and validates it.
 *
 * A body that is not JSON at all fails with `BAD_REQUEST` rather than a
 * validation error, because there is no field to point at.
 */
export async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', JSON_MESSAGE);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // The parser error can quote the payload, so it is discarded.
    throw new ApiError('BAD_REQUEST', JSON_MESSAGE);
  }

  return parseWithSchema(schema, body);
}

/** Response body for a validation failure. Contains field paths, never values. */
export function validationErrorBody(
  error: ValidationError,
  requestId?: string,
): {
  error: {
    code: 'VALIDATION_FAILED';
    message: string;
    fields: readonly FieldError[];
    requestId?: string;
  };
} {
  return {
    error: {
      code: 'VALIDATION_FAILED',
      message: error.publicMessage,
      fields: error.fields,
      ...(requestId ? { requestId } : {}),
    },
  };
}
