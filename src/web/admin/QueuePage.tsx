import { useEffect, useState } from 'react';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { formatDateTime } from '../lib/datetime';
import { adminApi } from './api';
import type { AdminListItem, ApplicationStatus } from './api';
import { StatusBadge } from './StatusBadge';
import { detailPath } from './route';

/**
 * The application queue (Issue #1 section 52).
 *
 * The default filter is work that needs the manager: unreadable payments,
 * applications waiting to be picked up, and work not yet recorded. A dashboard that opens on
 * everything makes the manager do the filtering, and this queue is one or two
 * applications a day: what matters is what is outstanding.
 *
 * Rows carry a name, a reference number, an amount and a status, and nothing
 * else. No address, no phone number, no card. This is the view most likely to be
 * left open on a shared screen or photographed, and none of that is needed to
 * decide which application to open.
 */

const OUTSTANDING: readonly ApplicationStatus[] = [
  'AWAITING_PAYMENT',
  'MANAGER_NOTIFIED',
  'NBTC_PROCESSING',
];

interface FilterOption {
  id: string;
  label: string;
  statuses: readonly ApplicationStatus[];
}

const FILTERS: readonly FilterOption[] = [
  { id: 'outstanding', label: 'ที่ต้องดำเนินการ', statuses: OUTSTANDING },
  { id: 'done', label: 'เสร็จสมบูรณ์', statuses: ['COMPLETED', 'NBTC_RECORDED'] },
  { id: 'paying', label: 'รอชำระเงิน', statuses: ['DRAFT', 'AWAITING_PAYMENT'] },
  {
    id: 'attention',
    label: 'ต้องตรวจสอบ',
    statuses: ['REJECTED', 'REFUND_REQUIRED', 'PAYMENT_VERIFIED', 'SUBMITTED'],
  },
  { id: 'all', label: 'ทั้งหมด', statuses: [] },
];

export interface QueuePageProps {
  onOpen: (path: string) => void;
}

/** Result of one request, tagged with the filter and attempt it belongs to. */
interface Loaded {
  items: AdminListItem[];
  filterId: string;
  attempt: number;
}

export function QueuePage({ onOpen }: QueuePageProps) {
  const [filterId, setFilterId] = useState('outstanding');
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ message: string; attempt: number } | null>(null);

  // State is set only when a response arrives, never synchronously here, and the
  // result carries the filter it was for - so switching filters quickly cannot
  // leave the slower response on screen under the newer label.
  useEffect(() => {
    let cancelled = false;
    const filter = FILTERS.find((candidate) => candidate.id === filterId) ?? FILTERS[0]!;

    adminApi
      .list(filter.statuses)
      .then((response) => {
        if (!cancelled) setLoaded({ items: response.applications, filterId, attempt });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setFailure({
          message: caught instanceof Error ? caught.message : 'ไม่สามารถโหลดรายการได้',
          attempt,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [filterId, attempt]);

  const fresh = loaded?.filterId === filterId && loaded.attempt === attempt;
  const items = fresh
    ? loaded.items.filter(
        (item) =>
          filterId !== 'outstanding' ||
          item.status !== 'AWAITING_PAYMENT' ||
          item.manualPaymentReview,
      )
    : null;
  const error = failure?.attempt === attempt ? failure.message : null;
  const busy = items === null && error === null;
  const reload = () => setAttempt((previous) => previous + 1);

  return (
    <>
      <h1 className="vra-admin__title">ใบสมัครสมาชิก</h1>

      <div className="vra-filters" role="group" aria-label="กรองตามสถานะ">
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={filter.id === filterId ? 'vra-chip vra-chip--active' : 'vra-chip'}
            aria-pressed={filter.id === filterId}
            onClick={() => setFilterId(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {error ? (
        <>
          <Alert tone="error">{error}</Alert>
          <Button variant="secondary" onClick={reload}>
            ลองโหลดอีกครั้ง
          </Button>
        </>
      ) : null}

      {busy ? <p className="vra-muted">กำลังโหลด...</p> : null}

      {items !== null && items.length === 0 ? (
        <Alert tone="info">
          <p>ไม่มีใบสมัครในสถานะนี้</p>
        </Alert>
      ) : null}

      {items !== null && items.length > 0 ? (
        <ul className="vra-queue">
          {items.map((item) => (
            <li className="vra-queue__item" key={item.id}>
              {/*
                A real link, so it can be opened in a new tab, copied, or
                bookmarked - all of which a manager working through a queue does.
                The click is intercepted for in-app navigation, but a middle
                click or a modifier still does the browser's own thing.
              */}
              <a
                className="vra-queue__link"
                href={detailPath(item.id)}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                    return;
                  event.preventDefault();
                  onOpen(detailPath(item.id));
                }}
              >
                <span className="vra-queue__reference">
                  {item.referenceNo ?? 'ยังไม่ออกเลขที่ใบสมัคร'}
                </span>
                <span className="vra-queue__name">{item.name ?? 'ไม่ระบุชื่อ'}</span>
              </a>

              <div className="vra-queue__meta">
                <StatusBadge status={item.status} />
                {item.manualPaymentReview ? <span>รอตรวจสอบการชำระเงินโดยเจ้าหน้าที่</span> : null}
                {item.amountBaht ? <span>{item.amountBaht} บาท</span> : null}
                <span className="vra-muted">
                  {item.submittedAt
                    ? `ส่งเมื่อ ${formatDateTime(item.submittedAt)}`
                    : `สร้างเมื่อ ${formatDateTime(item.createdAt)}`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
