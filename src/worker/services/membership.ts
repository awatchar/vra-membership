import type { MembershipType } from '../db';

/**
 * Membership catalogue (Issue #1 section 4).
 *
 * The amount is resolved here and nowhere else. The client sends only a
 * membership type; an amount arriving from a client is ignored, because a value
 * the payer controls must never decide what the payer owes.
 *
 * Amounts are integers in satang so that comparing a slip against the expected
 * total never involves a floating-point baht value.
 */

export interface MembershipPlan {
  type: MembershipType;
  amountSatang: number;
  /** Thai label for the payment page and the receipt. */
  labelTh: string;
}

const PLANS: Readonly<Record<MembershipType, MembershipPlan>> = {
  FIVE_YEAR: {
    type: 'FIVE_YEAR',
    amountSatang: 50_000,
    labelTh: 'สมาชิกสามัญราย 5 ปี',
  },
  LIFETIME: { type: 'LIFETIME', amountSatang: 200_000, labelTh: 'สมาชิกสามัญตลอดชีพ' },
};

export function membershipPlan(type: MembershipType): MembershipPlan {
  return PLANS[type];
}

export function membershipPlans(): readonly MembershipPlan[] {
  return Object.values(PLANS);
}

/** Formats satang as a Thai baht amount, e.g. `500.00`. */
export function formatBaht(amountSatang: number): string {
  const baht = Math.trunc(amountSatang / 100);
  const satang = Math.abs(amountSatang % 100);
  return `${baht.toLocaleString('en-US')}.${String(satang).padStart(2, '0')}`;
}
