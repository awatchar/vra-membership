# Security and Privacy Baseline

## Data classification

| Class | Examples | Repository / logs |
| --- | --- | --- |
| Secret | API keys, webhook secrets, encryption keys | Never |
| Restricted PII | citizen ID, address, DOB, member photo | Never |
| Ephemeral image | full ID card, payment slip | Never persist |
| Internal metadata | request ID, internal application ID, error code | Allowed when minimized |
| Public | documentation, public branding assets | Allowed |

## Required controls

- Cloudflare Access ป้องกัน admin routes; ห้ามสร้าง password auth เองโดยไม่มี decision record
- Turnstile, validation, MIME/size checks และ rate limiting ป้องกัน public endpoints ที่มีค่าใช้จ่าย
- Webhooks ต้องตรวจ signature, replay protection และ idempotency
- Payment amount และ receiver ถูก resolve/validate ฝั่ง backend เท่านั้น
- Transaction reference, application number และ receipt number ต้อง unique/concurrency-safe
- R2 เป็น private; object keys เป็น random identifiers และไม่มี PII
- Logs ใช้ allowlist ของ technical metadata ไม่ dump object/request/provider response
- Retention และ deletion ต้องกำหนดก่อน production พร้อม audit trail ที่ไม่เก็บ payload ลับ

ทุก PR ต้องระบุ security/privacy impact แม้คำตอบคือ “ไม่มี” พร้อมเหตุผลสั้น ๆ
