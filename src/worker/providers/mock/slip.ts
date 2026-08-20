import type {
  SlipTransaction,
  SlipVerificationProvider,
  SlipVerificationRequest,
  SlipVerificationResult,
} from '../types';

/** Deterministic slip verification stand-in for development and tests. */

export const MOCK_TRANSACTION: SlipTransaction = {
  transactionRef: 'MOCKTXN0000000001',
  amount: 500,
  sendingBank: 'BBL',
  receivingBank: 'KBANK',
  receiverAccountDigits: '1234',
  receiverName: 'สมาคมนักวิทยุอาสาสมัคร (ตัวอย่าง)',
  transactionAt: '2026-01-02T03:04:05.000Z',
};

export interface MockSlipOptions {
  transaction?: Partial<SlipTransaction>;
  failWith?: Extract<SlipVerificationResult, { ok: false }>['reason'];
  /** When true the returned amount mirrors `expectedAmount`. */
  matchExpectedAmount?: boolean;
}

export function createMockSlipProvider(options: MockSlipOptions = {}): SlipVerificationProvider {
  return {
    name: 'mock-slip',
    async verify(request: SlipVerificationRequest): Promise<SlipVerificationResult> {
      if (options.failWith) {
        return { ok: false, reason: options.failWith };
      }
      const amount =
        options.transaction?.amount ??
        (options.matchExpectedAmount === false ? MOCK_TRANSACTION.amount : request.expectedAmount);
      return {
        ok: true,
        transaction: { ...MOCK_TRANSACTION, ...options.transaction, amount },
      };
    },
  };
}
