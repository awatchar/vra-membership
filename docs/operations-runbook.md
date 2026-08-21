# Production operations runbook

Runbook นี้ใช้กับ `vra-membership` production เท่านั้น ทุกคำสั่งต้องรันจาก clean checkout ของ `main` และห้าม paste output ที่อาจมี PII/secret ลง Issue, PR หรือ chat

## Health and deployment

ตรวจ liveness ซึ่งไม่เรียก provider และไม่คืน PII:

```bash
curl -fsS https://member.vra.or.th/api/health
```

ผลต้องเป็น HTTP 200, `environment=production`, `providerMode=live` Deployment หลักต้องผ่าน GitHub `Deploy` workflow เท่านั้น หากล้มเหลวให้แก้สาเหตุแล้ว rerun failed jobs; ห้ามข้าม quality gates หรือ deploy commit จาก branch อื่น

ถ้า run ใหม่ขึ้น `pending` แต่ไม่มี job ให้ตรวจ run เก่าของ workflowเดียวกันที่ `waiting` และ cancel เฉพาะ run เก่าหลังยืนยันว่าไม่ได้ deploy อยู่ Workflow ปัจจุบันตรวจ kill switch นอก protected environment จึงไม่ควรรอ approval เมื่อ delivery ถูกปิด

## Logs without PII

ค้นด้วย `requestId`, event, HTTP status, provider/status enum และช่วงเวลาเท่านั้น ห้ามค้นหรือ export ด้วยชื่อ, email, โทรศัพท์, citizen ID, address, form body, image หรือ provider payload Logger ตัด key ที่ไม่อยู่ใน allowlist แต่ผู้ดูแลยังต้องไม่เพิ่ม raw error/payload เข้า log query, dashboard annotation หรือ incident note

เหตุการณ์ retention มีเพียง:

```text
retention.abandoned_deleted  count
retention.pii_erased         count
retention.records_deleted    count
retention.failed             errorCode=RETENTION_FAILED
```

เมื่อ `retention.failed` ให้ตรวจ D1/R2 availability และ Cron Past Events แล้ว retry หลังแก้สาเหตุ การทำซ้ำ idempotent

## Retention and erasure

Cron production: `17 19 * * *` UTC (02:17 Asia/Bangkok) ทดสอบ handler ใน local ได้ด้วย `wrangler dev --test-scheduled` และ `GET /__scheduled?cron=17+19+*+*+*` ห้ามใช้ production database ในการทดสอบ

ตั้ง hold โดยใช้ internal application id หรือ reference number ที่ผู้ดูแลค้นจาก admin portal แล้วรันผ่าน authenticated Wrangler session:

```bash
npx wrangler d1 execute DB --env production --remote --command \
  "UPDATE applications SET retention_hold_until='2030-01-01T00:00:00.000Z' WHERE reference_no='VRA-XXXX'"
```

ยกเลิก hold ด้วย `retention_hold_until=NULL` ต้องมี human approval เพราะอาจทำให้ record ถูกลบใน Cron ถัดไป ห้ามใส่ citizen ID หรือชื่อใน command/history

## Provider outage

- iApp ล่ม/timeout: ให้ผู้สมัครลองใหม่หรือใช้ manual entry; ห้ามเก็บภาพบัตรเพื่อ retry ภายหลัง
- SlipOK ล่ม/timeout: ไม่เปลี่ยนสถานะ payment และไม่เก็บภาพสลิป ให้ผู้สมัคร retry ด้วย transaction เดิม ระบบ duplicate guard ป้องกันการใช้ซ้ำ
- Resend ล่ม: email record/idempotency key เดิมต้องถูกใช้ในการ retry ห้ามสร้าง email row ใหม่เพื่อ “ลองอีกครั้ง”
- Turnstile ล่ม: live endpoints fail closed ห้ามเปลี่ยน production เป็น mock หรือปิด verification
- Cloudflare Access ล่ม: admin fail closed; งานสมัคร public ที่ไม่พึ่ง admin ทำต่อได้

## Stuck workflow

ใช้ admin portal ตรวจสถานะและ audit timeline ก่อน retry การ acknowledge/completion เป็น compare-and-set และ idempotent ห้ามแก้ status ด้วย SQL ยกเว้น incident ที่มี Issue, backup และ human approval ถ้า email open ไม่ขยับ `NBTC_PROCESSING` ให้ผู้จัดการใช้ปุ่ม “รับเรื่อง / เริ่มดำเนินการ” ซึ่งเป็น fallback ที่ออกแบบไว้

## Secret rotation

อัปโหลดด้วย `scripts/set-production-secrets.ps1` หรือ `wrangler secret put NAME --env production` ผ่าน stdin จากนั้นทดสอบ feature ที่เกี่ยวข้องด้วยข้อมูลทดสอบที่ลบได้

- iApp, SlipOK, Resend, Turnstile และ Access values: สร้างค่าใหม่, upload, verify แล้ว revoke ค่าเดิม
- Resend webhook: ช่วงเปลี่ยนต้องประสาน endpoint/signing secret ไม่ให้ event ระหว่างทางหาย
- `PII_ENCRYPTION_KEY`: **ห้าม rotate โดยตรง** เพราะ ciphertext และ duplicate hash เดิมจะอ่านไม่ได้ ต้องมี migration/re-encryption plan, backup และ human approval ก่อน
- CI token: rotate ใน Cloudflare แล้วอัปเดต GitHub `production` environment secret ก่อน revoke ค่าเดิม

อย่า log ค่า, ใช้ command-line argument ที่มองเห็นใน process list หรือส่งค่าใน Issue/PR

## Backup, rollback and incident response

- Worker rollback: `wrangler deployments list --env production` แล้ว `wrangler rollback <DEPLOYMENT_ID> --env production`
- Schema ใช้ forward-fix migration เท่านั้น ห้ามแก้ migration ที่ apply แล้ว
- D1 recovery ใช้ Time Travel ตาม `docs/deployment.md`; การ restore เป็น high-risk และต้องมี human approval
- เมื่อสงสัยว่า secret/PII รั่ว: หยุดช่องทางรับข้อมูลถ้าจำเป็น, preserve technical evidence ที่ไม่มี PII, revoke secret, จำกัด access, ประเมินผลกระทบและการแจ้งตามกฎหมาย แล้วบันทึก timeline ด้วย request/commit/deployment ids เท่านั้น
