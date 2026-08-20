# Architecture

ข้อกำหนดฉบับเต็มอยู่ใน [Issue #1](https://github.com/awatchar/vra-membership/issues/1) เอกสารนี้บันทึกเฉพาะ architecture ที่ยืนยันแล้วและต้องอัปเดตเมื่อมีการตัดสินใจผ่าน PR

```text
Browser
  -> Cloudflare Worker + static assets
      -> D1: applications, payments, receipts, events
      -> private R2: selected member photos only
      -> iApp: OCR through a server-side provider adapter
      -> SlipOK: payment verification through a server-side provider adapter
      -> Resend: email and verified webhooks

Admin routes -> Cloudflare Access
Public abuse controls -> Cloudflare Turnstile and rate limiting
```

## Code layout

```text
src/worker/            Cloudflare Worker (Hono)
  index.ts             entrypoint, per-request context, error mapping
  env.ts               validated non-secret configuration and secret access
  context.ts           Hono generics shared by every route
  routes/              HTTP routes
  db/                  data access layer; the only module that knows SQL
    types.ts           internal models and the status/type unions
    mappers.ts         row to model conversion
    repository.ts      parameterised queries grouped per aggregate
    errors.ts          constraint-violation translation
  lib/logger.ts        allowlist logger; the only sanctioned console sink
  lib/http.ts          API error codes and applicant-safe messages
  lib/crypto.ts        citizen ID encryption and duplicate-lookup hashing
  lib/citizen-id.ts    citizen ID normalisation and check-digit validation
  providers/types.ts   OcrProvider, SlipVerificationProvider, EmailProvider
  providers/mock/      deterministic adapters used by development and tests
src/web/               React client, built to dist/client
migrations/            append-only D1 migrations
tests/                 Vitest suites, all running inside workerd
```

Static assets are served through the Workers assets binding with
`run_worker_first` on `/api/*`, so the Worker owns every API route and the client
bundle handles all other paths as a single-page application.

## Boundaries

- ภาพบัตรประชาชนทั้งใบ: อยู่ใน request memory ชั่วคราว ส่งให้ OCR แล้วทิ้ง
- รูปสลิป: decode ใน browser เป็นหลัก; fallback ประมวลผลใน Worker memory แล้วทิ้ง
- รูปสมาชิก: เก็บเฉพาะรูปที่ผู้สมัครเลือกและยืนยันแล้วใน private R2
- Business objects: map จาก provider response เป็น internal model; ไม่เก็บ raw response
- Secrets: Cloudflare Secrets เท่านั้น ไม่อยู่ใน browser, repository, Issue, PR หรือ logs

## Data model

```text
applications ──1:1── addresses
      │
      ├──1:N── payments ──1:1── receipts
      ├──1:N── emails
      └──1:N── application_events
```

Confirmed properties of the schema, enforced by `migrations/0001_create_core_schema.sql`:

- ไม่มี column สำหรับเก็บภาพบัตร ภาพสลิป raw provider response bounding box หรือศาสนา
- เลขบัตรประชาชนมีเฉพาะ `citizen_id_ciphertext` (AES-GCM) และ `citizen_id_hash` (keyed hash) ไม่มี column plain text
- `citizen_id_hash` มี index แต่ไม่ unique เพราะสมาชิกคนเดิมต้องสมัคร/ต่ออายุได้มากกว่าหนึ่งครั้ง
- ที่อยู่ตามบัตรไม่มี `id_postcode` เพราะบัตรประชาชนไม่มีรหัสไปรษณีย์
- `payments.transaction_ref`, `applications.reference_no` และ `receipts.receipt_no` เป็น `UNIQUE`
- จำนวนเงินเก็บเป็นจำนวนเต็มหน่วยสตางค์ เพื่อไม่ให้มีการคำนวณด้วย floating point ใน payment path
- Timestamp ทั้งหมดเป็น ISO 8601 UTC และแปลงเป็น Asia/Bangkok เฉพาะตอนแสดงผล
- `status`, `membership_type`, `photo_source`, email `type`/`status` และ `actor_type` ถูกจำกัดด้วย `CHECK` constraint
- `metadata_json` ของ audit event รับได้เฉพาะ object แบนที่มีค่าเป็น primitive และถูกกรองอีกครั้งตอนอ่าน

## Decision records

การเปลี่ยน technology, trust boundary, data retention, state machine, schema หรือ deployment strategy ต้องอธิบายเหตุผลและ trade-offs ใน PR และเพิ่ม decision record ภายใต้ `docs/decisions/` เมื่อมีผลระยะยาว
