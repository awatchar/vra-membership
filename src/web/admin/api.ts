/**
 * The admin API from the browser.
 *
 * Separate from `src/web/api/client.ts` because the two halves authenticate
 * completely differently and share nothing useful. The applicant carries a
 * capability token in a header; the manager is authenticated by the Cloudflare
 * Access cookie the browser sends on its own, and every state change has to
 * carry the CSRF token issued by `GET /api/admin/session` - because a cookie is
 * sent on cross-site requests too.
 *
 * Nothing here is stored. The CSRF token lives in React state for the life of
 * the tab, and the Access cookie is the browser's business.
 */

const GENERIC_MESSAGE = 'ไม่สามารถติดต่อระบบได้ กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง';

export class AdminRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'AdminRequestError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------ wire types --- */

export type ApplicationStatus =
  | 'DRAFT'
  | 'AWAITING_PAYMENT'
  | 'PAYMENT_VERIFIED'
  | 'SUBMITTED'
  | 'MANAGER_NOTIFIED'
  | 'NBTC_PROCESSING'
  | 'NBTC_RECORDED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'REFUND_REQUIRED'
  | 'REFUNDED';

export interface AdminSession {
  manager: { email: string };
  csrf: { header: string; token: string };
}

export interface AdminListItem {
  id: string;
  referenceNo: string | null;
  status: ApplicationStatus;
  name: string | null;
  membershipType: 'ANNUAL' | 'LIFETIME' | null;
  amountBaht: string | null;
  submittedAt: string | null;
  createdAt: string;
}

export interface AdminEvent {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  metadata: Record<string, string | number | boolean> | null;
  createdAt: string;
}

export interface AdminAddress {
  idAddress: string | null;
  idSubdistrict: string | null;
  idDistrict: string | null;
  idProvince: string | null;
  mailSameAsId: boolean;
  mailRecipient: string | null;
  mailAddress: string | null;
  mailSubdistrict: string | null;
  mailDistrict: string | null;
  mailProvince: string | null;
  mailPostcode: string | null;
  mailPhone: string | null;
}

export type WorkflowStepName =
  'APPLICATION_NUMBER' | 'RECEIPT' | 'RECEIPT_EMAIL' | 'SUBMISSION' | 'MANAGER_EMAIL';

export interface AdminDetail {
  application: {
    id: string;
    referenceNo: string | null;
    status: ApplicationStatus;
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
    membershipType: 'ANNUAL' | 'LIFETIME' | null;
    membershipLabel: string | null;
    amountBaht: string | null;
    hasPhoto: boolean;
    photoSource: string | null;
    submittedAt: string | null;
    managerAcknowledgedAt: string | null;
    nbtcRecordedAt: string | null;
    nbtcRecordedBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
  address: AdminAddress | null;
  payment: {
    transactionRef: string;
    amountBaht: string;
    sendingBank: string | null;
    receivingBank: string | null;
    transactionAt: string | null;
    verifiedAt: string | null;
  } | null;
  receipt: { receiptNo: string; amountBaht: string; issuedAt: string } | null;
  workflow: {
    referenceNo: string | null;
    receiptNo: string | null;
    status: string;
    steps: Record<WorkflowStepName, 'DONE' | 'ALREADY_DONE' | 'FAILED' | 'SKIPPED'>;
    complete: boolean;
  };
  events: AdminEvent[];
}

export interface AcknowledgeResult {
  transition: string;
  processingEmailSent: boolean;
}

export interface CompletionResult {
  applicationId: string;
  status: ApplicationStatus;
  recorded: string;
  completionEmail: string;
  completed: string;
  complete: boolean;
}

/* ---------------------------------------------------------------- client --- */

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
}

async function toError(response: Response): Promise<AdminRequestError> {
  let body: ErrorBody | null;
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    body = null;
  }

  const code = typeof body?.error?.code === 'string' ? body.error.code : 'HTTP_ERROR';
  const message = typeof body?.error?.message === 'string' ? body.error.message : GENERIC_MESSAGE;
  return new AdminRequestError(code, message, response.status);
}

async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    // `same-origin` credentials so the Access cookie goes with the request; it
    // is the only thing authenticating it.
    response = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new AdminRequestError('NETWORK', GENERIC_MESSAGE, 0);
  }

  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

export interface Csrf {
  header: string;
  token: string;
}

function post<T>(path: string, csrf: Csrf): Promise<T> {
  return send<T>(path, { method: 'POST', headers: { [csrf.header]: csrf.token } });
}

export const adminApi = {
  session(): Promise<AdminSession> {
    return send<AdminSession>('/api/admin/session');
  },

  list(statuses: readonly ApplicationStatus[]): Promise<{ applications: AdminListItem[] }> {
    const query = statuses.length > 0 ? `?status=${statuses.join(',')}` : '';
    return send(`/api/admin/applications${query}`);
  },

  detail(applicationId: string): Promise<{ detail: AdminDetail }> {
    return send(`/api/admin/applications/${applicationId}`);
  },

  /** Asks for the full citizen ID. The server records that this happened. */
  citizenId(applicationId: string): Promise<{ citizenId: string | null }> {
    return send(`/api/admin/applications/${applicationId}/citizen-id`);
  },

  acknowledge(applicationId: string, csrf: Csrf): Promise<AcknowledgeResult> {
    return post(`/api/admin/applications/${applicationId}/acknowledge`, csrf);
  },

  completeNbtc(applicationId: string, csrf: Csrf): Promise<{ completion: CompletionResult }> {
    return post(`/api/admin/applications/${applicationId}/nbtc-complete`, csrf);
  },

  finalize(applicationId: string, csrf: Csrf): Promise<unknown> {
    return post(`/api/admin/applications/${applicationId}/finalize`, csrf);
  },

  /** Paths the browser loads directly, with the Access cookie attached. */
  photoUrl(applicationId: string): string {
    return `/api/admin/applications/${applicationId}/photo`;
  },

  receiptUrl(applicationId: string): string {
    return `/api/admin/applications/${applicationId}/receipt`;
  },
};
