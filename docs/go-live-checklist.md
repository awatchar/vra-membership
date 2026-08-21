# Production go-live checklist

Owner: repository/Cloudflare account owner<br>
Release Issue: [#19](https://github.com/awatchar/vra-membership/issues/19)<br>
Production URL: `https://member.vra.or.th`

ห้ามติ๊กจากเอกสารหรือ unit test เมื่อรายการระบุว่า “production” หลักฐานใน Issue ใช้ URL, timestamp, commit SHA, deployment id และผล enum/HTTP เท่านั้น ห้ามแนบ PII, ภาพบัตร, สลิป, secret หรือ provider payload

## Release gates

- [ ] Privacy notice ผ่าน human sign-off ตาม `docs/privacy-notice.md`
- [ ] Retention policy ผ่าน human sign-off และ migration/Cron deploy แล้ว
- [ ] APAC data location ได้รับการยอมรับก่อนมีข้อมูลจริง
- [ ] Cloudflare production secrets ครบ และ `PROVIDER_MODE=live`
- [ ] GitHub production environment มี CI token/account id, delivery variableเปิด และ reviewer อนุมัติ deploy
- [ ] Custom domain, TLS และ DNS พร้อม
- [ ] Cloudflare Access ครอบ `/admin*` และ `/api/admin/*`; ผู้ไม่ได้รับอนุญาตเข้าไม่ได้
- [ ] Turnstile แสดงและ server-side verification fail closed
- [ ] R2 `vra-member-private` ปิด `r2.dev` และไม่มี custom domain
- [ ] Edge rate-limit rules ครอบ OCR, payment verify และ member photo
- [ ] Resend domain/webhook พร้อมและ signature verification ผ่าน
- [ ] CI quality gates และ production config dry-run ผ่านบน commit ที่ deploy
- [ ] `/api/health` ได้ HTTP 200, production/live และมี `CF-Connecting-IP` ใน request จริง
- [ ] Security headers/CSP/HSTS/no-store ตรวจบน HTML, assets, API และ admin deep link
- [ ] Logs/CI artifacts ไม่มี PII หรือ secret

## Live provider verification

- [ ] iApp รับไฟล์ตามเพดาน 2 MB ที่ระบบกำหนด
- [ ] iApp field names/date formats ตรง mapping และ `face` เป็น raw base64 หรือ data URL ตามที่ adapter รองรับ
- [ ] SlipOK branch endpoint ใช้ branch id ถูกต้อง
- [ ] SlipOK ตรวจ valid/wrong amount/wrong receiver/duplicate/provider error โดยไม่ persist image
- [ ] Receiver masking ของธนาคารจริงมีเลขที่ตรวจได้อย่างน้อย 4 หลัก หรือ fail เป็น `RECEIVER_UNVERIFIABLE`
- [ ] PromptPay QR สแกนแล้วปลายทางและยอด ANNUAL/LIFETIME ถูกต้อง
- [ ] รูป crop จาก mobile browser อยู่ใน tolerance 0.02 และ 300x400 พิมพ์ได้จริง

## Scenario A — ANNUAL 500 THB

- [ ] อ่าน notice, OCR/manual fallback, ตรวจและแก้ข้อมูล
- [ ] เลือกรูปจากบัตรหรือ upload ใหม่ด้วย explicit selection
- [ ] กรอกที่อยู่จัดส่งและ postcode โดยไม่เดาจาก OCR
- [ ] Backend resolve `ANNUAL=500.00`; client amount ไม่ถูกเชื่อ
- [ ] ตรวจ payment, receiver และ duplicate ผ่าน; รูปสลิปไม่ถูกเก็บ
- [ ] สถานะไป `PAYMENT_VERIFIED`; ออกเลข/receipt PDF ภาษาไทย
- [ ] ส่ง receipt ให้สมาชิกและใบสมัครให้ผู้จัดการ
- [ ] ผู้จัดการเปิด/acknowledge แล้วไป `NBTC_PROCESSING` เพียงครั้งเดียว
- [ ] Admin ผ่าน Access ดู/download private member photo ได้
- [ ] authenticated POST ยืนยัน NBTC; GET ไม่เปลี่ยนสถานะ
- [ ] แจ้งสมาชิกพร้อม NBTC OSS link และสถานะ `COMPLETED`
- [ ] Audit timeline ครบและไม่มี payload/PII ใน log
- [ ] ลบข้อมูลทดสอบ/รูปตามขั้นตอนที่อนุมัติหลังเก็บหลักฐานทดสอบที่ไม่มี PII

## Scenario B — LIFETIME 2,000 THB

- [ ] ทำขั้นตอนเดียวกับ Scenario A ครบ โดย backend resolve `LIFETIME=2000.00`

## Critical acceptance criteria from Issue #1 section 81

- [ ] Full ID-card image is never persisted
- [ ] Slip image is never persisted
- [ ] Only the selected member photo is stored in private R2
- [ ] Admin is protected by Cloudflare Access and authenticated POST
- [ ] Provider/API keys never reach the browser, repository, logs or artifacts
- [ ] Annual/lifetime amounts, receiver and duplicate transaction checks pass
- [ ] Receipt, manager, processing and completion emails pass with idempotency
- [ ] Webhook signature/replay/idempotency checks pass
- [ ] Application/receipt numbering remains unique under concurrency
- [ ] Mobile UX and accessibility checks pass on Android, iPhone and desktop
- [ ] Fresh deploy from repository follows documented steps only
- [ ] Retention Cron and operations runbook are proven on production without real applicant data

## Sign-off record

บันทึกใน Issue #19:

```text
Commit/deployment:
Checked at (UTC):
Privacy/retention approver:
Scenario A result:
Scenario B result:
Known exceptions and expiry:
Go / No-go decision:
```
