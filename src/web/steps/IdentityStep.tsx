import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Field } from '../components/Field';
import { formatCitizenId } from '../state/validation';
import type { FieldErrors, IdentityField, IdentityValues } from '../state/validation';

/**
 * Reviewing what came off the card.
 *
 * The wording matters here. OCR output is a **pre-fill**, not a result: the
 * applicant is the one who confirms each value, and Issue #1 section 7 requires
 * it be treated that way. So the copy asks them to check the card, every field
 * is editable including the citizen ID, and nothing is presented as already
 * verified.
 *
 * The citizen ID is formatted as it is printed on the card while typing, because
 * that is the only way to compare thirteen digits without losing your place.
 */

export interface IdentityStepProps {
  values: IdentityValues;
  errors: FieldErrors<IdentityField>;
  fromOcr: boolean;
  busy: boolean;
  submitError: string | null;
  duplicateWarning: boolean;
  onChange: (values: Partial<IdentityValues>) => void;
  onSubmit: () => void;
  turnstileSlot: React.ReactNode;
}

export function IdentityStep({
  values,
  errors,
  fromOcr,
  busy,
  submitError,
  duplicateWarning,
  onChange,
  onSubmit,
  turnstileSlot,
}: IdentityStepProps) {
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {fromOcr ? (
        <Alert tone="info" title="กรุณาตรวจทานทุกช่อง">
          <p>
            ข้อมูลด้านล่างอ่านมาจากภาพบัตรและอาจคลาดเคลื่อนได้ ระบบจะใช้ข้อมูลที่ท่านยืนยันในหน้านี้
            ไม่ใช่ข้อมูลที่อ่านได้ กรุณาเทียบกับบัตรตัวจริงทีละช่อง
          </p>
        </Alert>
      ) : null}

      {duplicateWarning ? (
        <Alert tone="info" title="เลขบัตรนี้เคยสมัครไว้แล้ว">
          <p>
            ระบบพบใบสมัครก่อนหน้าที่ใช้เลขบัตรประชาชนนี้ ท่านสมัครต่อได้ตามปกติ
            หากไม่ได้ต้องการสมัครซ้ำ กรุณาติดต่อสมาคม
          </p>
        </Alert>
      ) : null}

      {submitError ? <Alert tone="error">{submitError}</Alert> : null}

      <Field
        label="เลขบัตรประชาชน"
        hint="13 หลักตามที่พิมพ์บนบัตร"
        inputMode="numeric"
        autoComplete="off"
        required
        value={formatCitizenId(values.citizenId)}
        error={errors.citizenId}
        onChange={(event) => onChange({ citizenId: event.target.value })}
      />

      <Field
        label="คำนำหน้า"
        autoComplete="honorific-prefix"
        value={values.title}
        onChange={(event) => onChange({ title: event.target.value })}
      />

      <Field
        label="ชื่อ (ภาษาไทย)"
        autoComplete="given-name"
        required
        value={values.firstName}
        error={errors.firstName}
        onChange={(event) => onChange({ firstName: event.target.value })}
      />

      <Field
        label="นามสกุล (ภาษาไทย)"
        autoComplete="family-name"
        required
        value={values.lastName}
        error={errors.lastName}
        onChange={(event) => onChange({ lastName: event.target.value })}
      />

      <Field
        label="ชื่อ (ภาษาอังกฤษ)"
        value={values.firstNameEn}
        onChange={(event) => onChange({ firstNameEn: event.target.value })}
      />

      <Field
        label="นามสกุล (ภาษาอังกฤษ)"
        value={values.lastNameEn}
        onChange={(event) => onChange({ lastNameEn: event.target.value })}
      />

      <Field
        label="วันเกิด"
        hint="รูปแบบ ปี-เดือน-วัน แบบคริสต์ศักราช เช่น 1990-01-15"
        type="date"
        value={values.birthDate}
        error={errors.birthDate}
        onChange={(event) => onChange({ birthDate: event.target.value })}
      />

      <Field
        label="วันหมดอายุบัตร"
        type="date"
        value={values.cardExpiryDate}
        error={errors.cardExpiryDate}
        onChange={(event) => onChange({ cardExpiryDate: event.target.value })}
      />

      {turnstileSlot}

      <Button type="submit" busy={busy} busyLabel="กำลังบันทึก...">
        ยืนยันข้อมูลนี้
      </Button>
    </form>
  );
}
