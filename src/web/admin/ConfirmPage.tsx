import { useEffect, useState } from 'react';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { adminApi } from './api';
import type { AdminDetail, Csrf } from './api';
import { StatusBadge } from './StatusBadge';

/**
 * The confirmation screen for the two irreversible actions (Issue #1 sections
 * 37-38).
 *
 * This page exists because the manager's email contains links, and email
 * security scanners open links. A `GET` that acted would let an anti-virus
 * gateway acknowledge an application or tell a member their registration is
 * complete. So the link lands here, the page shows who and what, and **nothing
 * happens until the manager presses the button**, which is a `POST` carrying the
 * CSRF token.
 *
 * The page loads the application first and refuses to offer the action when the
 * status does not allow it. Otherwise a stale link - the same email opened twice,
 * a week apart - would present a button that fails, and the manager would have no
 * idea whether their first press had worked.
 */

export type ConfirmAction = 'acknowledge' | 'nbtc-complete';

const COPY: Readonly<
  Record<
    ConfirmAction,
    {
      title: string;
      question: string;
      detail: string;
      button: string;
      busy: string;
      /** Statuses from which the action is meaningful. */
      allowed: readonly string[];
      /** Statuses that mean it has already been done. */
      alreadyDone: readonly string[];
    }
  >
> = {
  acknowledge: {
    title: 'ยืนยันการรับเรื่อง',
    question: 'ยืนยันว่าท่านได้รับเรื่องและเริ่มดำเนินการใบสมัครนี้',
    detail: 'ระบบจะแจ้งสมาชิกทางอีเมลว่าใบสมัครอยู่ระหว่างการดำเนินการ',
    button: 'ยืนยันว่ารับเรื่องแล้ว',
    busy: 'กำลังบันทึก...',
    allowed: ['MANAGER_NOTIFIED'],
    alreadyDone: ['NBTC_PROCESSING', 'NBTC_RECORDED', 'COMPLETED'],
  },
  'nbtc-complete': {
    title: 'ยืนยันการบันทึกทะเบียน กสทช.',
    question: 'กรุณายืนยันว่าได้บันทึกข้อมูลทะเบียนสมาชิกในระบบของสำนักงาน กสทช. เรียบร้อยแล้ว',
    detail: 'ระบบจะแจ้งสมาชิกทางอีเมลว่าการบันทึกทะเบียนเรียบร้อย และปิดใบสมัครนี้เป็นเสร็จสมบูรณ์',
    button: 'ยืนยันว่าบันทึกเรียบร้อยแล้ว',
    busy: 'กำลังบันทึก...',
    allowed: ['NBTC_PROCESSING'],
    alreadyDone: ['NBTC_RECORDED', 'COMPLETED'],
  },
};

export interface ConfirmPageProps {
  action: ConfirmAction;
  applicationId: string;
  csrf: Csrf;
  onDone: (path: string) => void;
  onCancel: () => void;
}

export function ConfirmPage({ action, applicationId, csrf, onDone, onCancel }: ConfirmPageProps) {
  const copy = COPY[action];
  const [detail, setDetail] = useState<AdminDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    adminApi
      .detail(applicationId)
      .then((response) => {
        if (!cancelled) setDetail(response.detail);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'ไม่สามารถโหลดใบสมัครนี้ได้');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applicationId, attempt]);

  const confirm = () => {
    // The guard is a ref-free early return plus the disabled button: the request
    // itself is idempotent on the server, so the worst a second press could do
    // is a wasted round trip - but the manager should not see two spinners.
    if (busy) return;
    setBusy(true);
    setError(null);

    const request =
      action === 'acknowledge'
        ? adminApi.acknowledge(applicationId, csrf).then(() => 'บันทึกการรับเรื่องแล้ว')
        : adminApi
            .completeNbtc(applicationId, csrf)
            .then((response) =>
              response.completion.complete
                ? 'บันทึกทะเบียนและแจ้งสมาชิกเรียบร้อยแล้ว'
                : 'บันทึกทะเบียนแล้ว แต่การแจ้งสมาชิกยังไม่สำเร็จ ระบบจะลองใหม่ได้จากหน้ารายละเอียด',
            );

    request
      .then((message) => {
        setOutcome(message);
        // Re-reads the application so the status shown after the action is the
        // one the server now holds, not the one the page loaded with.
        setAttempt((previous) => previous + 1);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'ไม่สามารถบันทึกได้');
      })
      .finally(() => setBusy(false));
  };

  if (!detail) {
    return (
      <>
        <h1 className="vra-admin__title">{copy.title}</h1>
        {error ? <Alert tone="error">{error}</Alert> : <p className="vra-muted">กำลังโหลด...</p>}
      </>
    );
  }

  const { application } = detail;
  const name = [application.title, application.firstName, application.lastName]
    .filter((part) => part && part.trim().length > 0)
    .join(' ');

  const already = copy.alreadyDone.includes(application.status);
  const allowed = copy.allowed.includes(application.status);

  return (
    <>
      <h1 className="vra-admin__title">{copy.title}</h1>

      <div className="vra-confirm">
        <p className="vra-confirm__reference">
          {application.referenceNo ?? 'ยังไม่ออกเลขที่ใบสมัคร'}
        </p>
        <p className="vra-confirm__name">{name.length > 0 ? name : 'ไม่ระบุชื่อ'}</p>
        <p>
          <StatusBadge status={application.status} />
        </p>
      </div>

      {outcome ? <Alert tone="success">{outcome}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      {already && !outcome ? (
        <Alert tone="info" title="ดำเนินการนี้ไปแล้ว">
          <p>
            ใบสมัครนี้ผ่านขั้นตอนนี้ไปแล้ว ไม่ต้องทำซ้ำ — หากเปิดจากอีเมลฉบับเก่า
            สถานะปัจจุบันคือสิ่งที่ถูกต้อง
          </p>
        </Alert>
      ) : null}

      {!allowed && !already && !outcome ? (
        <Alert tone="info" title="ยังไม่ถึงขั้นตอนนี้">
          <p>สถานะปัจจุบันของใบสมัครยังทำขั้นตอนนี้ไม่ได้ กรุณาตรวจสอบในหน้ารายละเอียด</p>
        </Alert>
      ) : null}

      {allowed && !outcome ? (
        <>
          <p className="vra-confirm__question">{copy.question}</p>
          <p className="vra-muted">{copy.detail}</p>
          <Button onClick={confirm} busy={busy} busyLabel={copy.busy}>
            {copy.button}
          </Button>
        </>
      ) : null}

      <Button
        variant="quiet"
        onClick={() => (outcome ? onDone(`/admin/applications/${applicationId}`) : onCancel())}
        disabled={busy}
      >
        {outcome ? 'ไปหน้ารายละเอียดใบสมัคร' : 'ยกเลิก'}
      </Button>
    </>
  );
}
