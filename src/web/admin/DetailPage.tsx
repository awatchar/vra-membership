import { useEffect, useState } from 'react';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { formatCalendarDate, formatDateTime } from '../lib/datetime';
import { adminApi } from './api';
import type { AdminDetail, Csrf, WorkflowStepName } from './api';
import { StatusBadge } from './StatusBadge';
import { Timeline } from './Timeline';

/**
 * One application, in full (Issue #1 section 53).
 *
 * The citizen ID is **not** loaded with the page. It is fetched by a button, and
 * the server records that read in the audit trail - so an entry there means the
 * manager looked the number up, not merely that they opened the page. It also
 * keeps the number off screen unless it is being used, which matters on a shared
 * or photographed display.
 *
 * The photo is an `<img>` pointing at the authenticated endpoint. The browser
 * sends the Access cookie itself, so there is no URL that works without it and
 * nothing to forward.
 */

const STEP_LABELS: Readonly<Record<WorkflowStepName, string>> = {
  APPLICATION_NUMBER: 'ออกเลขที่ใบสมัคร',
  RECEIPT: 'ออกใบสำคัญรับเงิน',
  RECEIPT_EMAIL: 'ส่งใบสำคัญรับเงินให้สมาชิก',
  SUBMISSION: 'ส่งใบสมัครเข้าระบบ',
  MANAGER_EMAIL: 'แจ้งผู้จัดการ',
};

const STEP_ORDER: readonly WorkflowStepName[] = [
  'APPLICATION_NUMBER',
  'RECEIPT',
  'RECEIPT_EMAIL',
  'SUBMISSION',
  'MANAGER_EMAIL',
];

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="vra-details__row">
      <dt>{label}</dt>
      <dd>{value && value.trim().length > 0 ? value : '—'}</dd>
    </div>
  );
}

function addressLine(parts: readonly (string | null)[]): string | null {
  const joined = parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join(' ');
  return joined.length > 0 ? joined : null;
}

export interface DetailPageProps {
  applicationId: string;
  csrf: Csrf;
  onOpen: (path: string) => void;
  onBack: () => void;
}

export function DetailPage({ applicationId, csrf, onOpen, onBack }: DetailPageProps) {
  const [detail, setDetail] = useState<AdminDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [citizenId, setCitizenId] = useState<string | null>(null);
  const [citizenIdError, setCitizenIdError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [transactionRef, setTransactionRef] = useState('');
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [approvingPayment, setApprovingPayment] = useState(false);

  const [attempt, setAttempt] = useState(0);
  const reload = () => setAttempt((previous) => previous + 1);

  // State is set only when the response arrives. `attempt` is what re-runs this
  // after an action, rather than calling a loader that sets state synchronously.
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

  const reveal = () => {
    if (revealing) return;
    setRevealing(true);
    setCitizenIdError(null);

    adminApi
      .citizenId(applicationId)
      .then((response) => {
        if (response.citizenId) setCitizenId(response.citizenId);
        else setCitizenIdError('ไม่สามารถอ่านเลขบัตรประชาชนของใบสมัครนี้ได้');
      })
      .catch((caught: unknown) => {
        setCitizenIdError(caught instanceof Error ? caught.message : 'ไม่สามารถอ่านเลขบัตรได้');
      })
      .finally(() => setRevealing(false));
  };

  const finalize = () => {
    if (finalizing) return;
    setFinalizing(true);

    adminApi
      .finalize(applicationId, csrf)
      .then(() => reload())
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'ไม่สามารถดำเนินการต่อได้');
      })
      .finally(() => setFinalizing(false));
  };

  const approvePayment = () => {
    if (approvingPayment || !paymentConfirmed || transactionRef.trim().length < 6) return;
    setApprovingPayment(true);
    setError(null);
    adminApi
      .approveManualPayment(applicationId, transactionRef, csrf)
      .then(() => reload())
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'ไม่สามารถยืนยันการชำระเงินได้');
      })
      .finally(() => setApprovingPayment(false));
  };

  if (error && !detail) {
    return (
      <>
        <Alert tone="error">{error}</Alert>
        <Button variant="secondary" onClick={onBack}>
          กลับไปรายการใบสมัคร
        </Button>
      </>
    );
  }

  if (!detail) return <p className="vra-muted">กำลังโหลด...</p>;

  const { application, address, payment, paymentReview, receipt, workflow, events } = detail;
  const outstanding = STEP_ORDER.filter(
    (step) => workflow.steps[step] !== 'DONE' && workflow.steps[step] !== 'ALREADY_DONE',
  );

  return (
    <>
      <button type="button" className="vra-back" onClick={onBack}>
        ← รายการใบสมัคร
      </button>

      <h1 className="vra-admin__title">{application.referenceNo ?? 'ยังไม่ออกเลขที่ใบสมัคร'}</h1>
      <p className="vra-admin__subtitle">
        <StatusBadge status={application.status} />
      </p>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="vra-panel">
        <h2 className="vra-panel__title">การดำเนินการ</h2>

        {paymentReview?.status === 'PENDING' && application.status === 'AWAITING_PAYMENT' ? (
          <div className="vra-form-stack">
            <Alert tone="info" title="รอตรวจสอบการชำระเงินโดยเจ้าหน้าที่">
              <p>
                ระบบอ่านสลิปไม่ได้และไม่ได้เก็บภาพไว้ กรุณาตรวจรายการเดินบัญชีของสมาคมให้พบยอด
                {application.amountBaht ? ` ${application.amountBaht} บาท` : ''}
                แล้วกรอกเลขอ้างอิงของธนาคารก่อนยืนยัน
              </p>
            </Alert>
            <label className="vra-field">
              <span className="vra-field__label">เลขอ้างอิงธุรกรรมจากรายการเดินบัญชี</span>
              <input
                className="vra-field__input"
                value={transactionRef}
                onChange={(event) => setTransactionRef(event.target.value)}
                autoComplete="off"
                maxLength={100}
              />
            </label>
            <label className="vra-check">
              <input
                type="checkbox"
                checked={paymentConfirmed}
                onChange={(event) => setPaymentConfirmed(event.target.checked)}
              />
              <span>ยืนยันว่าตรวจพบยอดเงินเข้าบัญชีสมาคมและเลขอ้างอิงตรงกับรายการจริง</span>
            </label>
            <Button
              onClick={approvePayment}
              disabled={!paymentConfirmed || transactionRef.trim().length < 6}
              busy={approvingPayment}
              busyLabel="กำลังยืนยัน..."
            >
              ยืนยันการชำระเงินและดำเนินใบสมัครต่อ
            </Button>
          </div>
        ) : null}

        {application.status === 'MANAGER_NOTIFIED' ? (
          <>
            <p>
              เมื่อพร้อมเริ่มดำเนินการ กดปุ่มด้านล่างเพื่อไปยังหน้ายืนยันการรับเรื่อง
              ระบบจะแจ้งสมาชิกว่ากำลังดำเนินการ
            </p>
            <Button onClick={() => onOpen(`/admin/applications/${applicationId}/acknowledge`)}>
              รับเรื่อง / เริ่มดำเนินการ
            </Button>
          </>
        ) : null}

        {application.status === 'NBTC_PROCESSING' ? (
          <>
            <p>
              เมื่อบันทึกข้อมูลทะเบียนสมาชิกในระบบของสำนักงาน กสทช. เรียบร้อยแล้ว
              กดปุ่มด้านล่างเพื่อไปยังหน้ายืนยัน
            </p>
            <Button onClick={() => onOpen(`/admin/applications/${applicationId}/nbtc-complete`)}>
              บันทึกในระบบ กสทช. เรียบร้อยแล้ว
            </Button>
          </>
        ) : null}

        {application.status === 'COMPLETED' ? (
          <Alert tone="success">
            <p>ใบสมัครนี้ดำเนินการครบถ้วนแล้ว ไม่มีขั้นตอนที่ต้องทำเพิ่ม</p>
          </Alert>
        ) : null}

        {payment && outstanding.length > 0 ? (
          <>
            <Alert tone="info" title="มีขั้นตอนหลังการชำระเงินที่ยังไม่สำเร็จ">
              <ul>
                {outstanding.map((step) => (
                  <li key={step}>{STEP_LABELS[step]}</li>
                ))}
              </ul>
              <p>
                การชำระเงินและใบสำคัญรับเงินไม่หายไป ขั้นตอนที่ค้างมักเป็นการส่งอีเมลที่ล้มชั่วคราว
              </p>
            </Alert>
            <Button
              variant="secondary"
              onClick={finalize}
              busy={finalizing}
              busyLabel="กำลังดำเนินการ..."
            >
              ลองดำเนินการขั้นตอนที่ค้างอีกครั้ง
            </Button>
          </>
        ) : null}
      </section>

      <section className="vra-panel">
        <h2 className="vra-panel__title">ผู้สมัคร</h2>
        <dl className="vra-details">
          <Row
            label="ชื่อ-นามสกุล"
            value={addressLine([application.title, application.firstName, application.lastName])}
          />
          <Row
            label="ชื่อภาษาอังกฤษ"
            value={addressLine([application.firstNameEn, application.lastNameEn])}
          />
          <Row label="วันเกิด" value={formatCalendarDate(application.birthDate)} />
          <Row label="วันหมดอายุบัตร" value={formatCalendarDate(application.cardExpiryDate)} />
          <Row label="อีเมล" value={application.email} />
          <Row label="โทรศัพท์" value={application.phone} />
          <Row label="สัญญาณเรียกขาน" value={application.callsign} />
        </dl>

        <div className="vra-reveal">
          <h3 className="vra-reveal__title">เลขบัตรประชาชน</h3>
          {citizenId ? (
            <p className="vra-reveal__value">{citizenId}</p>
          ) : (
            <>
              <p className="vra-muted">
                เลขบัตรประชาชนไม่ถูกโหลดมาพร้อมหน้านี้ กดเพื่อเปิดดูเมื่อจำเป็นต้องใช้
                <strong> การเปิดดูจะถูกบันทึกไว้ในประวัติการดำเนินการ</strong>
              </p>
              <Button
                variant="secondary"
                onClick={reveal}
                busy={revealing}
                busyLabel="กำลังเปิดดู..."
              >
                แสดงเลขบัตรประชาชน
              </Button>
            </>
          )}
          {citizenIdError ? <Alert tone="error">{citizenIdError}</Alert> : null}
        </div>
      </section>

      <section className="vra-panel">
        <h2 className="vra-panel__title">ที่อยู่</h2>
        <dl className="vra-details">
          <Row
            label="ที่อยู่ตามบัตร"
            value={addressLine([
              address?.idAddress ?? null,
              address?.idSubdistrict ?? null,
              address?.idDistrict ?? null,
              address?.idProvince ?? null,
            ])}
          />
          <Row
            label="ที่อยู่จัดส่ง"
            value={
              address?.mailSameAsId
                ? `ใช้ที่อยู่เดียวกับบัตร · รหัสไปรษณีย์ ${address.mailPostcode ?? '—'}`
                : addressLine([
                    address?.mailRecipient ?? null,
                    address?.mailAddress ?? null,
                    address?.mailSubdistrict ?? null,
                    address?.mailDistrict ?? null,
                    address?.mailProvince ?? null,
                    address?.mailPostcode ?? null,
                  ])
            }
          />
          <Row label="โทรศัพท์สำหรับจัดส่ง" value={address?.mailPhone ?? null} />
        </dl>
      </section>

      <section className="vra-panel">
        <h2 className="vra-panel__title">รูปสมาชิก</h2>
        {application.hasPhoto ? (
          <>
            <img
              className="vra-member-photo"
              src={adminApi.photoUrl(applicationId)}
              alt="รูปสำหรับบัตรสมาชิกของผู้สมัคร"
            />
            <p className="vra-muted">
              ที่มา: {application.photoSource === 'ID_CARD' ? 'ภาพใบหน้าจากบัตร' : 'รูปที่อัปโหลด'}
            </p>
            <p className="vra-field__hint">
              รูปนี้เข้าถึงได้เฉพาะผ่านระบบผู้จัดการ ไม่มีลิงก์ที่เปิดได้โดยไม่เข้าสู่ระบบ
            </p>
          </>
        ) : (
          <p className="vra-muted">ยังไม่มีรูปสมาชิก</p>
        )}
      </section>

      <section className="vra-panel">
        <h2 className="vra-panel__title">การชำระเงินและใบสำคัญรับเงิน</h2>
        <dl className="vra-details">
          <Row label="ประเภทสมาชิก" value={application.membershipLabel} />
          <Row
            label="ยอดค่าบำรุง"
            value={application.amountBaht ? `${application.amountBaht} บาท` : null}
          />
          <Row label="อ้างอิงรายการโอน" value={payment?.transactionRef ?? null} />
          <Row label="ธนาคารผู้รับเงิน" value={payment?.receivingBank ?? null} />
          <Row label="เวลาที่โอน" value={formatDateTime(payment?.transactionAt)} />
          <Row label="เวลาที่ตรวจสอบผ่าน" value={formatDateTime(payment?.verifiedAt)} />
          <Row label="เลขที่ใบสำคัญรับเงิน" value={receipt?.receiptNo ?? null} />
          <Row label="วันที่ออกใบสำคัญรับเงิน" value={formatDateTime(receipt?.issuedAt)} />
        </dl>

        {receipt ? (
          <p>
            <a className="vra-link" href={adminApi.receiptUrl(applicationId)}>
              ดาวน์โหลดใบสำคัญรับเงิน (PDF)
            </a>
          </p>
        ) : null}
      </section>

      <section className="vra-panel">
        <h2 className="vra-panel__title">การดำเนินการกับสำนักงาน กสทช.</h2>
        <dl className="vra-details">
          <Row
            label="ผู้จัดการรับเรื่องเมื่อ"
            value={formatDateTime(application.managerAcknowledgedAt)}
          />
          <Row label="บันทึกทะเบียนเมื่อ" value={formatDateTime(application.nbtcRecordedAt)} />
          <Row label="บันทึกโดย" value={application.nbtcRecordedBy} />
        </dl>
      </section>

      <section className="vra-panel">
        <h2 className="vra-panel__title">ประวัติการดำเนินการ</h2>
        <Timeline events={events} />
      </section>
    </>
  );
}
