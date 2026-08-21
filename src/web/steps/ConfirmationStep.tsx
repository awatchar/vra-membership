import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import type { StepState, WorkflowReport, WorkflowStep } from '../api/types';

/**
 * The confirmation page (Issue #1 section 66).
 *
 * It reports each post-payment step rather than a single "success", because the
 * steps really can differ: the payment is verified and the receipt issued, and
 * the email may still be waiting on a provider. Showing one tick for all of it
 * would mean an applicant whose receipt email failed has no idea, and no way to
 * ask for it again.
 *
 * The retry button appears only when something is actually outstanding, and it
 * calls the endpoint that resumes exactly the missing steps.
 */

const STEP_LABELS: Readonly<Record<WorkflowStep, string>> = {
  APPLICATION_NUMBER: 'ออกเลขที่ใบสมัคร',
  RECEIPT: 'ออกใบสำคัญรับเงิน',
  RECEIPT_EMAIL: 'ส่งใบสำคัญรับเงินไปยังอีเมลของท่าน',
  SUBMISSION: 'ส่งใบสมัครเข้าระบบ',
  MANAGER_EMAIL: 'แจ้งผู้จัดการสมาคม',
};

const ORDER: readonly WorkflowStep[] = [
  'APPLICATION_NUMBER',
  'RECEIPT',
  'RECEIPT_EMAIL',
  'SUBMISSION',
  'MANAGER_EMAIL',
];

function done(state: StepState): boolean {
  return state === 'DONE' || state === 'ALREADY_DONE';
}

export interface ConfirmationStepProps {
  report: WorkflowReport;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}

export function ConfirmationStep({ report, busy, error, onRetry }: ConfirmationStepProps) {
  const outstanding = ORDER.filter((step) => !done(report.steps[step]));

  return (
    <>
      <Alert tone="success" title="ได้รับใบสมัครและค่าบำรุงสมาชิกเรียบร้อยแล้ว">
        <p>สมาคมได้รับการชำระเงินของท่านและตรวจสอบแล้ว</p>
      </Alert>

      {report.referenceNo ? (
        <div className="vra-reference">
          <p className="vra-reference__label">เลขที่ใบสมัคร</p>
          <p className="vra-reference__value">{report.referenceNo}</p>
          <p className="vra-muted">กรุณาเก็บเลขนี้ไว้อ้างอิงเมื่อติดต่อสมาคม</p>
        </div>
      ) : null}

      {report.receiptNo ? (
        <dl className="vra-details">
          <div className="vra-details__row">
            <dt>เลขที่ใบสำคัญรับเงิน</dt>
            <dd>{report.receiptNo}</dd>
          </div>
        </dl>
      ) : null}

      <h2 className="vra-subheading">สถานะการดำเนินการ</h2>
      <ul className="vra-checklist">
        {ORDER.map((step) => {
          const state = report.steps[step];
          return (
            <li className="vra-checklist__item" key={step}>
              <span className="vra-checklist__mark" aria-hidden="true">
                {done(state) ? '✓' : '…'}
              </span>
              <span>
                {STEP_LABELS[step]}
                <span className="vra-visually-hidden">
                  {done(state) ? ' เรียบร้อยแล้ว' : ' อยู่ระหว่างดำเนินการ'}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {outstanding.length > 0 ? (
        <>
          <Alert tone="info" title="ยังมีบางขั้นตอนที่ไม่สำเร็จ">
            <p>
              การชำระเงินและใบสำคัญรับเงินของท่านถูกบันทึกไว้แล้วและไม่หายไป บางขั้นตอน เช่น
              การส่งอีเมล อาจไม่สำเร็จชั่วคราว กดปุ่มด้านล่างเพื่อลองอีกครั้งได้
            </p>
          </Alert>
          <Button variant="secondary" onClick={onRetry} busy={busy} busyLabel="กำลังลองอีกครั้ง...">
            ลองดำเนินการขั้นตอนที่ค้างอีกครั้ง
          </Button>
        </>
      ) : null}

      <h2 className="vra-subheading">ขั้นตอนต่อไป</h2>
      <p>
        ผู้จัดการสมาคมจะตรวจสอบใบสมัครและดำเนินการบันทึกข้อมูลทะเบียนสมาชิกในระบบของสำนักงาน กสทช.
        เมื่อดำเนินการเรียบร้อยแล้ว ระบบจะแจ้งผลให้ท่านทราบทางอีเมลอีกครั้ง
      </p>
      <p className="vra-muted">
        ใบสำคัญรับเงินเป็นหลักฐานการรับเงิน ไม่ใช่หลักฐานการบันทึกทะเบียนสมาชิกกับสำนักงาน กสทช.
      </p>
    </>
  );
}
