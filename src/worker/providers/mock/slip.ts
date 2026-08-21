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
  /** Clock for the default transfer time. Injected by tests that pin dates. */
  now?: () => Date;
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

      // The transfer time defaults to now rather than to the fixed value in
      // `MOCK_TRANSACTION`, because verification refuses a slip older than
      // seven days: a constant would make every mock payment fail as stale, in
      // local development as well as in tests. Callers that pin a clock pass
      // `transaction.transactionAt` or `now` and get exactly what they asked
      // for.
      const transactionAt =
        options.transaction?.transactionAt !== undefined
          ? options.transaction.transactionAt
          : (options.now ?? (() => new Date()))().toISOString();

      return {
        ok: true,
        transaction: { ...MOCK_TRANSACTION, ...options.transaction, amount, transactionAt },
      };
    },
  };
}
