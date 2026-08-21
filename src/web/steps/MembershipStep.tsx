import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import type { MembershipType } from '../api/types';

/**
 * Choosing the membership type (Issue #1 section 4).
 *
 * The prices shown here are labels on a choice, not an input. The amount is
 * resolved from the type on the server and the update endpoint has no amount
 * field at all, so a tampered price in the browser changes what the applicant
 * reads and nothing about what they owe.
 *
 * The two options are radio buttons in a `fieldset` rather than styled cards
 * with click handlers: a radio group is what this is, so arrow keys work, the
 * legend is announced, and the selection is stated rather than implied by a
 * border colour.
 */

interface Plan {
  type: MembershipType;
  label: string;
  price: string;
  detail: string;
}

/**
 * Mirrors the server's plans for display only. If these ever disagree, the
 * server is right - which is why the amount the applicant is asked to transfer
 * comes from the payment instructions endpoint and not from here.
 */
const PLANS: readonly Plan[] = [
  {
    type: 'FIVE_YEAR',
    label: 'สมาชิกสามัญราย 5 ปี',
    price: '500 บาท',
    detail: 'อายุสมาชิก 5 ปี',
  },
  {
    type: 'LIFETIME',
    label: 'สมาชิกสามัญตลอดชีพ',
    price: '2,000 บาท',
    detail: 'ชำระครั้งเดียว ไม่ต้องต่ออายุ',
  },
];

export interface MembershipStepProps {
  selected: MembershipType | null;
  busy: boolean;
  error: string | null;
  onSelect: (type: MembershipType) => void;
  onSubmit: () => void;
}

export function MembershipStep({ selected, busy, error, onSelect, onSubmit }: MembershipStepProps) {
  return (
    <>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <fieldset className="vra-fieldset">
        <legend className="vra-field__label">เลือกประเภทสมาชิก</legend>

        {PLANS.map((plan) => (
          <label className="vra-radio vra-radio--plan" key={plan.type}>
            <input
              type="radio"
              name="membership"
              checked={selected === plan.type}
              onChange={() => onSelect(plan.type)}
            />
            <span>
              <span className="vra-radio__title">{plan.label}</span>
              <span className="vra-radio__price">{plan.price}</span>
              <span className="vra-radio__detail">{plan.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <Button
        onClick={onSubmit}
        disabled={selected === null}
        busy={busy}
        busyLabel="กำลังเตรียมข้อมูลการชำระเงิน..."
      >
        ถัดไป
      </Button>
    </>
  );
}
