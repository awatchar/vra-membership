import { useState } from 'react';
import { Button } from '../components/Button';

/**
 * The privacy notice, which has to be accepted before anything is collected
 * (Issue #1 section 60).
 *
 * Written as plain statements about what happens to each thing, in the order the
 * applicant will encounter them, rather than as a consent form. The two points
 * that are easy to get wrong are stated explicitly: the card image is not kept,
 * and the member photo is chosen by the applicant rather than taken from the
 * card automatically.
 *
 * The checkbox starts unticked and the button stays disabled until it is ticked.
 * A pre-ticked box is not a decision.
 */

export interface PrivacyStepProps {
  onAccept: () => void;
}

const POINTS: readonly { title: string; body: string }[] = [
  {
    title: 'ภาพบัตรประชาชน',
    body: 'ใช้เพื่ออ่านข้อมูลบนบัตรเท่านั้น ระบบไม่เก็บภาพบัตร และภาพจะถูกทิ้งทันทีที่อ่านข้อมูลเสร็จ',
  },
  {
    title: 'รูปสำหรับบัตรสมาชิก',
    body: 'ท่านเลือกเองว่าจะใช้ภาพใบหน้าจากบัตรประชาชน หรืออัปโหลดรูปใหม่ ระบบจะไม่ใช้ภาพจากบัตรโดยที่ท่านไม่ได้เลือก รูปที่เลือกจะถูกเก็บไว้เพื่อจัดทำและบริหารจัดการบัตรสมาชิก',
  },
  {
    title: 'ภาพสลิปการโอนเงิน',
    body: 'ตามปกติเบราว์เซอร์ของท่านจะอ่าน QR บนสลิปแล้วส่งเฉพาะข้อมูลอ้างอิง ภาพสลิปจะไม่ออกจากเครื่องของท่าน หากอ่าน QR ไม่ได้จึงจะส่งภาพ และระบบไม่เก็บภาพสลิป',
  },
  {
    title: 'เลขบัตรประชาชน',
    body: 'ถูกเข้ารหัสก่อนบันทึก ใช้เพื่อตรวจสอบการสมัครซ้ำและเพื่อบันทึกทะเบียนสมาชิกกับสำนักงาน กสทช. เท่านั้น',
  },
  {
    title: 'ผู้ให้บริการที่เกี่ยวข้อง',
    body: 'ข้อมูลบางส่วนถูกส่งไปยังผู้ให้บริการที่จำเป็นต่อกระบวนการ ได้แก่ การอ่านข้อมูลบัตร การตรวจสอบสลิปการโอนเงิน และการส่งอีเมล',
  },
];

export function PrivacyStep({ onAccept }: PrivacyStepProps) {
  const [accepted, setAccepted] = useState(false);

  return (
    <>
      <dl className="vra-notice">
        {POINTS.map((point) => (
          <div className="vra-notice__item" key={point.title}>
            <dt className="vra-notice__term">{point.title}</dt>
            <dd className="vra-notice__detail">{point.body}</dd>
          </div>
        ))}
      </dl>

      <label className="vra-checkbox">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>ข้าพเจ้าอ่านและเข้าใจข้อความข้างต้น และยินยอมให้ดำเนินการตามที่ระบุ</span>
      </label>

      <Button onClick={onAccept} disabled={!accepted}>
        เริ่มสมัครสมาชิก
      </Button>
    </>
  );
}
