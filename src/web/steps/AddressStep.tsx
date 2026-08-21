import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Field } from '../components/Field';
import type { AddressField, AddressValues, FieldErrors } from '../state/validation';

/**
 * Both addresses (Issue #1 sections 9.1 and 9.2).
 *
 * The postcode sits outside the "same as the card" toggle on purpose. A Thai ID
 * card does not print one, so it can only come from the applicant - copying the
 * card address across cannot fill it in, and hiding the field behind the toggle
 * would produce an address that cannot be posted to.
 *
 * The mailing fields are hidden rather than disabled when the toggle is on: a
 * disabled field still reads out to a screen reader as part of the form and still
 * takes up space on a phone.
 */

export interface AddressStepProps {
  values: AddressValues;
  errors: FieldErrors<AddressField>;
  busy: boolean;
  submitError: string | null;
  fromOcr: boolean;
  onChange: (values: Partial<AddressValues>) => void;
  onSubmit: () => void;
}

export function AddressStep({
  values,
  errors,
  busy,
  submitError,
  fromOcr,
  onChange,
  onSubmit,
}: AddressStepProps) {
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {submitError ? <Alert tone="error">{submitError}</Alert> : null}

      {fromOcr ? (
        <Alert tone="info">
          <p>ที่อยู่ด้านล่างอ่านมาจากบัตร กรุณาตรวจทานและแก้ให้ตรงกับบัตรตัวจริง</p>
        </Alert>
      ) : null}

      <h2 className="vra-subheading">ที่อยู่ตามบัตรประชาชน</h2>

      <Field
        label="ที่อยู่ตามบัตร"
        hint="บ้านเลขที่ หมู่ ซอย ถนน ตามที่พิมพ์บนบัตร"
        required
        value={values.idAddress}
        error={errors.idAddress}
        onChange={(event) => onChange({ idAddress: event.target.value })}
      />
      <Field
        label="ตำบล / แขวง"
        value={values.idSubdistrict}
        error={errors.idSubdistrict}
        onChange={(event) => onChange({ idSubdistrict: event.target.value })}
      />
      <Field
        label="อำเภอ / เขต"
        value={values.idDistrict}
        error={errors.idDistrict}
        onChange={(event) => onChange({ idDistrict: event.target.value })}
      />
      <Field
        label="จังหวัด"
        required
        value={values.idProvince}
        error={errors.idProvince}
        onChange={(event) => onChange({ idProvince: event.target.value })}
      />

      <h2 className="vra-subheading">ที่อยู่สำหรับจัดส่งเอกสาร</h2>

      <label className="vra-checkbox">
        <input
          type="checkbox"
          checked={values.mailSameAsId}
          onChange={(event) => onChange({ mailSameAsId: event.target.checked })}
        />
        <span>ใช้ที่อยู่เดียวกับที่อยู่ตามบัตร</span>
      </label>

      <Field
        label="รหัสไปรษณีย์"
        hint="บัตรประชาชนไม่มีรหัสไปรษณีย์ จึงต้องกรอกเองทุกกรณี"
        inputMode="numeric"
        autoComplete="postal-code"
        maxLength={5}
        required
        value={values.mailPostcode}
        error={errors.mailPostcode}
        onChange={(event) => onChange({ mailPostcode: event.target.value })}
      />

      {values.mailSameAsId ? null : (
        <>
          <Field
            label="ชื่อผู้รับ"
            hint="กรอกเมื่อผู้รับเอกสารไม่ใช่ชื่อของท่านเอง"
            value={values.mailRecipient}
            onChange={(event) => onChange({ mailRecipient: event.target.value })}
          />
          <Field
            label="ที่อยู่จัดส่ง"
            required
            value={values.mailAddress}
            error={errors.mailAddress}
            onChange={(event) => onChange({ mailAddress: event.target.value })}
          />
          <Field
            label="ตำบล / แขวง"
            value={values.mailSubdistrict}
            error={errors.mailSubdistrict}
            onChange={(event) => onChange({ mailSubdistrict: event.target.value })}
          />
          <Field
            label="อำเภอ / เขต"
            value={values.mailDistrict}
            error={errors.mailDistrict}
            onChange={(event) => onChange({ mailDistrict: event.target.value })}
          />
          <Field
            label="จังหวัด"
            required
            value={values.mailProvince}
            error={errors.mailProvince}
            onChange={(event) => onChange({ mailProvince: event.target.value })}
          />
          <Field
            label="โทรศัพท์สำหรับติดต่อเรื่องจัดส่ง"
            type="tel"
            inputMode="tel"
            value={values.mailPhone}
            onChange={(event) => onChange({ mailPhone: event.target.value })}
          />
        </>
      )}

      <Button type="submit" busy={busy} busyLabel="กำลังบันทึก...">
        ถัดไป
      </Button>
    </form>
  );
}
