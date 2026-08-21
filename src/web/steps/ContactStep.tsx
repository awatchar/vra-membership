import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Field } from '../components/Field';
import type { ContactValues, ContactField, FieldErrors } from '../state/validation';

/**
 * Contact details (Issue #1 section 10).
 *
 * The email field says why it is required rather than only that it is: the
 * receipt, the processing notice and the completion notice all arrive there, so
 * a wrong address means the applicant pays and then hears nothing. That is worth
 * a sentence in the form instead of a support call later.
 */

export interface ContactStepProps {
  values: ContactValues;
  errors: FieldErrors<ContactField>;
  busy: boolean;
  submitError: string | null;
  onChange: (values: Partial<ContactValues>) => void;
  onSubmit: () => void;
}

export function ContactStep({
  values,
  errors,
  busy,
  submitError,
  onChange,
  onSubmit,
}: ContactStepProps) {
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {submitError ? <Alert tone="error">{submitError}</Alert> : null}

      <Field
        label="อีเมล"
        hint="ใบสำคัญรับเงินและการแจ้งผลทุกครั้งจะส่งไปที่อีเมลนี้ กรุณาตรวจให้แน่ใจว่าถูกต้อง"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        value={values.email}
        error={errors.email}
        onChange={(event) => onChange({ email: event.target.value })}
      />

      <Field
        label="หมายเลขโทรศัพท์"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        required
        value={values.phone}
        error={errors.phone}
        onChange={(event) => onChange({ phone: event.target.value })}
      />

      <Field
        label="สัญญาณเรียกขาน (ถ้ามี)"
        hint="กรอกได้หากท่านมีสัญญาณเรียกขานอยู่แล้ว ไม่มีก็ข้ามได้"
        autoComplete="off"
        value={values.callsign}
        onChange={(event) => onChange({ callsign: event.target.value })}
      />

      <Button type="submit" busy={busy} busyLabel="กำลังบันทึก...">
        ถัดไป
      </Button>
    </form>
  );
}
