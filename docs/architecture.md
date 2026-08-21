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
    webhooks.ts        provider callbacks; signature is the only authentication
    admin.ts           manager endpoints, authenticated in the Worker itself
  db/                  data access layer; the only module that knows SQL
    types.ts           internal models and the status/type unions
    mappers.ts         row to model conversion
    repository.ts      parameterised queries grouped per aggregate
    errors.ts          constraint-violation translation
  security/            controls applied before business rules run
    turnstile.ts       bot protection, verified before any provider call
    rate-limit.ts      fixed-window counters in D1, hashed identifiers
    access.ts          Cloudflare Access JWT verification, done again here
    csrf.ts            origin check plus double-submit token for admin POSTs
    validation.ts      strict zod parsing that never echoes a submitted value
    context.ts         per-request assembly of the above
  services/            business rules; no SQL, no HTTP
    state-machine.ts   validated, idempotent, concurrency-safe transitions
    numbering.ts       application and receipt numbers
    application.ts     application lifecycle up to payment
    application-access.ts  applicant capability tokens
    membership.ts      the two plans and their prices
    audit.ts           audit trail with an allowlist for metadata
    member-photo.ts    the only image the system keeps
    payment.ts         the five checks that accept a payment
    receipt.ts         receipt issuing and regeneration
    email.ts           transactional email, recorded per message
    email-events.ts    delivery events, and the one status change they cause
    application-workflow.ts  what happens after a payment is verified
    nbtc-completion.ts       recording the registration and finishing
    admin-view.ts            what the manager sees; the only audited decrypt
    workflow-factory.ts      assembly shared by the routes that run it
  lib/logger.ts        allowlist logger; the only sanctioned console sink
  lib/time.ts          Asia/Bangkok conversion and Buddhist-era years
  lib/http.ts          API error codes and applicant-safe messages
  lib/crypto.ts        citizen ID encryption and duplicate-lookup hashing
  lib/citizen-id.ts    citizen ID normalisation and check-digit validation
  lib/files.ts         magic-byte sniffing and size-limited body reads
  lib/images.ts        dimension reading and JPEG metadata stripping
  lib/promptpay.ts     Thai QR Payment payload with an exact amount
  lib/pdf/fonts.ts     Sarabun embedding, subsetted per document
  lib/pdf/receipt.ts   the receipt document itself
  lib/association.ts   the association's own name and public links
  emails/layout.ts     block renderer producing HTML and text together
  emails/templates.ts  the four transactional templates
  providers/types.ts   OcrProvider, SlipVerificationProvider, EmailProvider
  providers/iapp/      Thai national ID OCR adapter; narrows the response
  providers/slipok/    payment slip verification adapter
  providers/resend/    transactional email adapter and webhook signatures
  providers/mock/      deterministic adapters used by development and tests
assets/fonts/          Sarabun (OFL), vendored so a receipt never needs the network
src/web/               React client, built to dist/client
  App.tsx              the applicant wizard; one lock, no persistence
  api/client.ts        the only place the browser talks to the API
  state/wizard.ts      one reducer holding every answer
  state/validation.ts  Thai messages that say what to do
  lib/image.ts         downscale and square-crop on a canvas
  lib/qr.ts            slip QR read in the browser, not uploaded
  lib/turnstile.ts     the one third-party script, loaded lazily
  components/          Field, Button, Alert, CropBox, QrCode, StepFrame
  steps/               one component per wizard step
  lib/datetime.ts      Bangkok time and the Buddhist era, everywhere
  admin/AdminApp.tsx   manager portal; path routing, no router dependency
  admin/api.ts         admin API; Access cookie plus the CSRF token
  admin/QueuePage.tsx  the queue, carrying no detail beyond a name
  admin/DetailPage.tsx one application; the citizen ID is a separate request
  admin/ConfirmPage.tsx  the page an email link lands on; acts only on a POST
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

## Application state machine

```text
DRAFT ──> AWAITING_PAYMENT ──> PAYMENT_VERIFIED ──> SUBMITTED
  │              │                    │                 │
  │              │                    │                 ▼
  │              │                    │           MANAGER_NOTIFIED
  │              │                    │                 │
  │              │                    │                 ▼
  │              │                    │           NBTC_PROCESSING
  │              │                    │                 │
  │              │                    │                 ▼
  │              │                    │            NBTC_RECORDED ──> COMPLETED
  │              │                    │
  └──> CANCELLED ┘                    └──> REFUND_REQUIRED ──> REFUNDED

REJECTED reachable from AWAITING_PAYMENT onwards, and leads to REFUND_REQUIRED
CANCELLED reachable only before a payment exists
COMPLETED, CANCELLED and REFUNDED are terminal
```

คุณสมบัติที่บังคับไว้ใน `src/worker/services/state-machine.ts` และมี test ครอบทั้งสามข้อ

- **Validated** transition ที่ไม่อยู่ในตารางถูกปฏิเสธ ไม่มี code path ใดกระโดดข้ามขั้นได้
- **Idempotent** การขอสถานะที่เป็นอยู่แล้วเป็น no-op ไม่บันทึก audit event ซ้ำ และไม่ทำ side effect ซ้ำ
- **Concurrency-safe** การเขียนเป็น compare-and-set บนสถานะที่อ่านมาจริง ไม่ใช่บนชุด predecessor ทั้งหมด เพื่อให้ `from` ใน audit event เป็นค่าที่เคยเป็นจริงเสมอ

## Numbering

`VRA-{พ.ศ.}-{running}` และ `VRA-RC-{พ.ศ.}-{running}` โดย prefix และความยาว sequence เป็น config ปี พ.ศ. คำนวณจากเวลา Asia/Bangkok ไม่ใช่จากวัน UTC ใบสมัครที่ส่งเวลา 23:30 UTC ของวันที่ 31 ธันวาคม จึงได้เลขของปีถัดไป

ความไม่ซ้ำเป็นการรับประกันจาก `UNIQUE` constraint ไม่ใช่จาก application layer ระบบเสนอเลขจากค่าสูงสุดที่ออกไปแล้วบวกหนึ่ง แล้วให้ constraint ตัดสิน ผู้แพ้อ่านค่าสูงสุดใหม่และลองอีกครั้ง จึงได้ลำดับที่ไม่ซ้ำและไม่มีเลขขาดหาย

## Public endpoint controls

ทุก endpoint สาธารณะที่มีค่าใช้จ่ายต้องผ่านลำดับนี้ก่อนถึง business logic

```text
request
  -> Turnstile        ตรวจก่อนเรียก provider ใด ๆ เพราะการตรวจทีหลังยังทำให้เกิดค่าใช้จ่าย
  -> rate limit       fixed window ใน D1 ต่อ scope และต่อ client
  -> file validation  sniff magic bytes และจำกัดขนาดระหว่างอ่าน stream
  -> zod validation   strict object ปฏิเสธ field ที่ไม่รู้จัก
  -> business logic
```

Admin endpoint ที่เปลี่ยนสถานะเพิ่มอีกสองชั้น: ตรวจ `Origin` และ double-submit CSRF token ที่เทียบแบบ constant time เพราะ Cloudflare Access ใช้ cookie ซึ่งถูกส่งไปกับ cross-site request ด้วย

หลักที่ใช้ตัดสินใจ

- **Content-Type ที่ client ส่งมาเป็นเพียงคำใบ้** ชนิดไฟล์ตัดสินจาก magic bytes ไฟล์ PDF หรือ script ที่เปลี่ยนนามสกุลเป็น `.jpg` ต้องไม่ถึง provider หรือ bucket
- **ขนาดไฟล์ถูกบังคับระหว่างอ่าน ไม่ใช่หลังอ่านจบ** การ buffer ไฟล์ทั้งก้อนแล้วค่อยวัดคือวิธีที่ Worker ถูกฆ่าด้วย request เดียว
- **Field ที่ไม่รู้จักถูกปฏิเสธ ไม่ใช่ถูกตัดออกเงียบ ๆ** client ที่ส่ง `amount` มาพร้อม `membershipType` เข้าใจ contract ผิด และการตัดออกเงียบ ๆ ปิดบังเรื่องนั้น
- **ข้อความ error ไม่มีค่าที่ผู้ใช้ส่งมา** ค่าเหล่านั้นคือเลขบัตร ที่อยู่ และ email ตอบกลับเฉพาะ path ของ field กับข้อความภาษาไทยตามชนิดของข้อผิดพลาด
- **Rate limit counter อยู่ใน D1 ไม่ใช่ในหน่วยความจำของ isolate** Worker หนึ่งตัวรันหลาย isolate พร้อมกัน counter ในหน่วยความจำจึงไม่จำกัดอะไรเลย และ bucket ที่เก็บเป็น keyed hash ของ `<scope>:<identifier>` ไม่ใช่ IP ตรง ๆ
- **rate limit ใน application layer ไม่แทน rule ที่ edge** rule ของ Cloudflare หยุด traffic ก่อนถึง Worker จึงกันทั้งค่า invocation และค่า D1 write ที่ counter ใช้ ต้องตั้งทั้งสองชั้น

## Images

ระบบแตะภาพสามชนิดและปฏิบัติกับมันต่างกันโดยเจตนา

| ภาพ                       | ที่อยู่        | อายุ                   |
| ------------------------- | -------------- | ---------------------- |
| บัตรประชาชนด้านหน้า       | request memory | ถูกทิ้งเมื่อจบ request |
| สลิปการชำระเงิน           | request memory | ถูกทิ้งเมื่อจบ request |
| รูปสมาชิกที่ผู้สมัครเลือก | private R2     | เก็บไว้เพื่อทำบัตร     |

รูปสมาชิกเป็นภาพเดียวที่ถูกเก็บ กฎที่บังคับไว้

- **Object key เป็น UUID สุ่ม** ไม่มีเลขบัตร ชื่อ callsign หรือ application id อยู่ในนั้น การ list bucket ต้องไม่กลายเป็นทะเบียนสมาชิก
- **ไม่มี R2 custom metadata** เพราะเป็นอีกที่ที่ข้อมูลส่วนบุคคลจะสะสมได้ ความเชื่อมโยงอยู่ใน database แล้ว
- **การเปลี่ยนรูปลบ object เดิม** ถ้าไม่ลบ การถ่ายใหม่ทุกครั้งจะทิ้งใบหน้าที่ไม่มีอะไรอ้างถึงไว้ใน bucket และไม่มีใครจะไปลบมัน
- **EXIF ถูกลบก่อนเขียนลง bucket** ภาพจากมือถืออาจมีพิกัด GPS หมายเลขเครื่อง และเวลาถ่าย เมื่อผูกกับใบหน้าของคนที่ระบุตัวได้ นั่นคือประวัติตำแหน่ง
- **ต้องมีการยืนยันอย่างชัดเจน** การใช้ภาพใบหน้าจากบัตรโดยผู้สมัครไม่ได้เลือกเองคือสิ่งที่ Issue #1 หัวข้อ 61 ห้าม

การครอบตัดและ re-encode ทำที่ browser ส่วน Worker เป็นฝ่าย **ตรวจ** ไม่ใช่เชื่อ: อ่านขนาดพิกเซลจาก container header (ไม่ต้องมี decoder) ตรวจสัดส่วน 3:4 และลบ metadata segment ทิ้ง Worker ไม่มี canvas และการใส่ WASM decoder จะเพิ่ม bundle size กับ CPU ทุก upload โดยไม่คุ้มที่ปริมาณ 1-2 ใบสมัครต่อวัน

รับเฉพาะ JPEG สำหรับรูปที่เก็บ เพราะ metadata ของ PNG และ WebP อยู่ใน chunk ที่โมดูลนี้ไม่ได้เขียนใหม่ การรับไว้จะเท่ากับเก็บ chunk ที่อาจมี EXIF หรือข้อความติดมา

## Applicant access

ผู้สมัครไม่มี account ไม่มี password และไม่มีการ login ตามเจตนาของ Issue #1 — กรอกฟอร์มครั้งเดียวแล้วไม่กลับมาอีก

แต่ application id เป็น UUID ที่ปรากฏใน URL และในหน้า confirmation จึงไม่ใช่ความลับ ถ้า id เพียงอย่างเดียวอ่านใบสมัครได้ ใครที่เห็น id — จาก browser history, screenshot, หรือ support ticket — จะอ่านเลขบัตร ที่อยู่ และเบอร์โทรของคนนั้นได้ ภัยคุกคามที่แท้จริงไม่ใช่การเดา id แต่เป็นการเห็นโดยบังเอิญ

ผู้สมัครจึงได้ **capability token**: ค่าสุ่ม 32 bytes ที่ออกให้ครั้งเดียวตอนสร้างใบสมัคร และต้องแนบมากับทุก request หลังจากนั้น

- เก็บเฉพาะ **keyed hash** ของ token ด้วยเหตุผลเดียวกับที่เลขบัตรเก็บเป็น ciphertext: สำเนาของ database ต้องไม่มอบ credential ที่ใช้งานได้
- **ไม่มีทางขอ token ใหม่** โดยเจตนา ช่องทาง "ส่ง token ให้ฉันอีกครั้ง" จะกลายเป็นวิธียึดใบสมัครด้วยการรู้ email
- token ที่ผิด token ที่ขาด และใบสมัครที่ไม่มีอยู่ ให้คำตอบเหมือนกันทุกไบต์ (ยกเว้น `requestId`) การตอบต่างกันจะทำให้ผู้เรียกยืนยันได้ว่า id ใดมีอยู่จริง
- แถวที่ไม่มี hash เก็บไว้ อ่านไม่ได้เลย ซึ่งเป็นโหมดล้มเหลวที่ถูกต้อง

## Payment

ห้าข้อต้องเป็นจริงก่อนสมาคมจะยอมรับว่าได้รับเงิน และทุกข้อตรวจในระบบเราเอง ไม่ใช่เชื่อคำตอบของ provider

1. **รายการมีอยู่จริง** ในระบบธนาคาร
2. **เงินเข้าบัญชีสมาคม** ธนาคารปิดบังเลขบัญชีไว้บางส่วน จึงตรวจว่าเลขที่มองเห็นเรียงอยู่ในเลขบัญชีที่ตั้งค่าไว้ ถ้าเห็นน้อยกว่า 4 หลักถือว่า **ยืนยันไม่ได้** ไม่ใช่ผ่าน เพราะการอนุมัติเงินโดยไม่รู้ว่าเงินไปไหนเป็นการล้มเหลวผิดทาง
3. **ยอดตรงกับประเภทสมาชิก** ที่ resolve จาก server ยอดจาก client ไม่มี code path ไปถึงการเปรียบเทียบนี้เลย
4. **สลิปยังไม่เคยถูกใช้** ตัดสินด้วย `UNIQUE(transaction_ref)` ไม่ใช่การอ่านก่อนเขียน และส่ง `log: true` ให้ SlipOK บันทึกไว้ตรวจซ้ำอีกชั้น
5. **เวลาโอนสมเหตุสมผล** ไม่เก่ากว่า 7 วัน และไม่อยู่ในอนาคตเกิน 15 นาที (เผื่อนาฬิกาคลาด)

ก่อนทำทั้งห้าข้อ ระบบตรวจว่าใบสมัครอยู่สถานะ `AWAITING_PAYMENT` จริง — state machine ถือว่าการ transition ซ้ำเข้า `PAYMENT_VERIFIED` เป็น no-op ซึ่งถูกต้องโดยทั่วไป แต่ในบริบทนี้หมายความว่า "ใบสมัครนี้จ่ายแล้ว" การรับสลิปที่สองจะบันทึกการชำระเงินซ้ำและแจ้งผู้สมัครว่าสำเร็จ การตรวจก่อนยังประหยัดค่าเรียก provider ที่คิดเงินต่อครั้งด้วย

จำนวนเงินเป็นจำนวนเต็มหน่วยสตางค์ทุกจุด ยอดจาก SlipOK ถูกปัดเป็นสตางค์ที่ขอบระบบ เพื่อให้การเปรียบเทียบทุกครั้งเป็นการเทียบจำนวนเต็ม

รูปสลิปไม่ถูกเก็บ และในเส้นทางหลักมันไม่ถึง Worker เลย: browser อ่าน QR แล้วส่งเฉพาะ payload (Issue #1 หัวข้อ 18)

## Receipts

ใบสำคัญรับเงินออกทันทีที่ payment ผ่านการตรวจ ไม่ต้องรอผู้จัดการ เพราะมันยืนยันเรื่องเดียวคือ **สมาคมได้รับเงินแล้ว** ส่วนการบันทึกทะเบียนกับ กสทช. เป็นข้อเท็จจริงอีกเรื่องที่เกิดตามมาภายหลัง เอกสารจึงพูดเรื่องนี้ตรง ๆ ว่าไม่ใช่หลักฐานการบันทึกทะเบียน — ผู้สมัครที่อ่านผิดจะเลิกรอ email ที่บอกว่าขึ้นทะเบียนแล้วจริง

**ไฟล์ PDF ไม่ถูกเก็บที่ไหนเลย** ทั้ง D1 และ R2 (Issue #1 หัวข้อ 26) ของจริงที่คงอยู่คือ receipt record ใน D1 และ `renderReceiptPdf` รับค่าทุกตัวจาก caller ไม่ไปอ่านเองในฟังก์ชัน จึงมี code path เดียวสำหรับการออกครั้งแรกและการ regenerate ภายหลัง — "สร้างใหม่ให้เหมือนเดิม" เป็นคุณสมบัติที่พิสูจน์ได้ ไม่ใช่การประกอบขึ้นใหม่ให้ใกล้เคียง

`issue()` เป็น idempotent: ถ้ามีใบแล้วก็คืนใบนั้น และถ้าสองคำขอชนกันจนฝ่ายที่แพ้ติด unique constraint ของตาราง ฝ่ายที่แพ้จะได้ใบที่ชนะไป ไม่ใช่ error เพราะสิ่งที่ผู้เรียกถามคือ "ใบของใบสมัครนี้" ซึ่งตอนนี้มีแล้ว การออกเลขที่สองบน payment เดียวจะทำให้เอกสารที่สมาชิกถืออยู่กับในระบบอ้างเลขต่างกัน

### Thai text ใน PDF

Standard PDF fonts เขียนภาษาไทยไม่ได้เลย — `drawText` throw ไม่ใช่ออกมาเป็นตัวอักษรเพี้ยน จึงฝัง Sarabun (OFL) ไว้ใน repository และ subset ต่อเอกสาร ทำให้ใบเสร็จหนึ่งใบราว 12 KB แทนที่จะแบก font ทั้งชุดราว 180 KB ไปกับ email ทุกฉบับ

Sarabun จัดตำแหน่งสระและวรรณยุกต์ด้วยการ **แทน glyph ผ่าน GSUB** ไม่ใช่ขยับด้วย GPOS offset ดังนั้น layout run จะรายงาน offset เป็นศูนย์ทั้งหมดแม้จัดรูปถูกต้องแล้ว สิ่งที่เปลี่ยนคือ glyph ที่เลือก — `น้` กับ `น้ำ` ใช้ glyph วรรณยุกต์ต่างตัวกันเพราะต้องวางไม่เหมือนกันเมื่อมีสระอำตามหลัง การ assert บน offset จึงดูเหมือน fail ทั้งที่ถูก test จริงคือ assert ว่า glyph id เปลี่ยนตามบริบท

ผลข้างเคียงที่ทราบแล้วอย่างหนึ่ง: สระอำถูกจัดรูปเป็น นิคหิต + สระอา และสระอาที่ใช้เป็น glyph **ตัวเดียวกัน** กับสระอาเดี่ยว pdf-lib เขียน `/ToUnicode` หนึ่งรายการต่อ glyph จากบริบทแรกที่พบ จึงเสียการอ่านย้อนกลับไปหนึ่งแบบต่อ font glyph ที่วาดถูกต้องเสมอ **หน้าจอและกระดาษจึงถูกต้อง** ที่คลาดเคลื่อนคือการ copy ข้อความออกจากไฟล์เท่านั้น test เปรียบเทียบโดยตัดสระอา/อำ ออกจากทั้งสองฝั่ง (`tests/support/pdf-text.ts`) ตัวอื่นทั้งหมดยังตรวจตรงตัวรวมทั้งลำดับ

Endpoint สำหรับ admin regenerate ยังไม่เปิด เพราะสิทธิ์ในการดึงเอกสารที่มี PII ต้องผ่าน admin authentication ซึ่งมาพร้อม Cloudflare Access ใน #16 — service มี `render()` พร้อมแล้วและรอเพียงชั้นสิทธิ์

## Email

สี่แบบตาม Issue #1 หัวข้อ 55 และทุกแบบมีทั้ง HTML และ plain text โดย **ทั้งสองรูปแบบถูก render จาก block list เดียวกัน** ไม่ได้เขียนแยกกัน plain-text ที่เขียนมือจะเริ่มไม่ตรงกับ HTML ตั้งแต่การแก้ครั้งแรก และคนที่ได้ text version คือคนที่มีทางเลี่ยงน้อยที่สุด

HTML เขียนแบบเก่าโดยตั้งใจ — table, inline style, คอลัมน์เดียว, กว้างไม่เกิน 600px เพราะ email client ตัด `<style>` และไม่รองรับ layout สมัยใหม่ คอลัมน์เดียวคือสิ่งที่ทำให้อ่านบนมือถือได้โดยไม่ต้องมี media query เลย

**อีเมลที่ส่งไม่สำเร็จไม่ทำให้สิ่งที่มันรายงานล้มเหลว** ตอนส่งอีเมลใบเสร็จ สมาคมได้เงินและออกเลขใบสำคัญรับเงินไปแล้ว ถ้า Resend ล่ม ข้อเท็จจริงเหล่านั้นต้องยังเป็นจริง การส่งจึงบันทึกผลของตัวเองแล้ว return ไม่ throw และสิ่งเดียวที่ throw คือการถามถึงใบสมัครที่ไม่มีอยู่

แถวใน `emails` ถูกสร้าง **ก่อน** เรียก provider เพราะการส่งที่ timeout อาจถึงผู้รับไปแล้ว ถ้าไม่มีแถวก็ไม่มีอะไรให้ retry และไม่มีอะไรให้ webhook ที่ตามมาจับคู่ `retry` ใช้แถวเดิม จึงใช้ idempotency key เดิม — Resend จะคืน message เดิมภายใน 24 ชั่วโมงแทนที่จะส่งซ้ำ ที่ทำได้เพราะ template ทุกตัวเป็น pure function ของข้อมูลที่เก็บไว้ ถ้าเนื้อหาต่างกันระหว่างสองครั้ง Resend จะตอบ `invalid_idempotent_request` ไม่ใช่ deduplicate

### อีเมลผู้จัดการ

ไม่แนบรูปบัตรประชาชน รูปสลิป หรือรูปสมาชิกเลย (หัวข้อ 31) ทุกอย่างเป็น link เข้าระบบผู้จัดการ และ link ทั้งสามพาไปหน้ายืนยัน ไม่มี GET ใดเปลี่ยนสถานะ เพราะ email security scanner เปิด URL เองได้ (หัวข้อ 37)

เลขบัตรประชาชนแสดงเพียงสี่หลักท้ายในตำแหน่งจริงบนบัตร ดู `docs/decisions/0002-citizen-id-not-in-email.md` การถอดรหัสเพื่อ mask ยังบันทึก audit event เหมือนการอ่านครั้งอื่น

### Open tracking

Resend ไม่มี field ต่อ message สำหรับ open tracking — มันเป็นคุณสมบัติของ sending domain ดังนั้น `trackOpens` จึงเลือก **sender อีกตัว** (`EMAIL_FROM_TRACKED`) ที่ตั้ง open tracking ไว้ แทนการ set field ถ้าไม่ตั้ง sender ตัวที่สอง `trackOpens` จะไม่มีผลและ open ของผู้จัดการจะไม่ขยับสถานะใบสมัคร ซึ่งรับได้เพราะผู้จัดการมีปุ่มกดเองอยู่แล้วและไม่มีขั้นตอนใดพึ่ง tracking เพียงทางเดียว (หัวข้อ 34)

### Webhook

`POST /api/webhooks/resend` เป็น endpoint สาธารณะที่ **เปลี่ยนสถานะใบสมัครได้** signature จึงเป็นสิ่งเดียวที่กั้นระหว่างอินเทอร์เน็ตกับ state machine และถูกตรวจด้วย implementation จริงในทุก environment ไม่ผ่าน provider container — เพราะ `PROVIDER_MODE=mock` ตอบว่า "ถูกต้อง" กับทุกอย่าง การเอา mock ไปวางตำแหน่งนี้จะทำให้ endpoint ที่เปลี่ยนสถานะได้กลายเป็น endpoint ที่ไม่มี authentication

Resend เซ็นด้วย Svix: HMAC-SHA256 บน `${svix-id}.${svix-timestamp}.${raw body}` โดย secret ตัด `whsec_` ออกแล้ว base64-decode `payload` ต้องเป็น body ดิบ byte ต่อ byte — การ serialize JSON ที่ parse แล้วใหม่จะเปลี่ยน whitespace และ signature ทุกตัวจะไม่ตรง (test ยืนยันด้วย vector ที่ Svix เผยแพร่เอง) การเทียบเป็น constant time และปฏิเสธ timestamp ที่ห่างเกิน 5 นาที เพราะ signature ที่ถูกต้องจะถูกต้องตลอดไป ถ้าไม่ตรวจเวลาก็ replay ได้ไม่จำกัด body ถูกอ่านโดยจำกัดขนาดที่ 64 KB เพราะ signature ตรวจได้หลังอ่าน body แล้ว การอ่านจึงต้องมีขอบเขตของตัวเอง

หลัง signature ผ่าน **ทุกอย่างตอบ 2xx** Resend retry non-2xx ต่อเนื่องเป็นชั่วโมง (5 วินาที, 5 นาที, 30 นาที, 2 ชม., 5 ชม., 10 ชม.) การปฏิเสธ event ที่เราไม่ได้ใช้จึงได้แค่ redelivery ยาว ๆ โดยไม่ได้อะไร event ที่ไม่รู้จัก, email id ที่ไม่รู้จัก และ body ที่ parse ไม่ได้ ถูกตอบรับทั้งหมด

Turnstile ไม่เกี่ยวเพราะผู้เรียกเป็น server ไม่ใช่คน CSRF ก็ไม่เกี่ยวเพราะไม่มี browser session อยู่ในเส้นทางนี้ การกันปริมาณเป็นงานของ edge rate-limiting rule ใน `docs/owner-actions.md` เพราะการ drop delivery event จริงคือการเสียมันไปถาวร

Resend ส่งแบบ at-least-once และเอกสารของเขาเตือนว่า event **อาจมาไม่เรียงลำดับ** ดังนั้นไม่มีอะไรในนี้สมมติลำดับ: `email.delivered` เลื่อนสถานะได้เฉพาะจาก `QUEUED`/`SENT` เท่านั้น `email.bounced` ที่มาก่อนจึงไม่ถูก `email.delivered` ที่มาช้าทับ และ `email.sent` ถือเป็น metadata ไม่แตะสถานะ เพราะเส้นทางส่งของเราบันทึกไว้แล้วด้วย id เดียวกัน

### สองทางเข้าสู่ NBTC_PROCESSING

ผู้จัดการเปิดอีเมล (`email.opened`) หรือกดปุ่มในอีเมล ทั้งสองทางอยู่ใน `email-events.ts` ไฟล์เดียวกันโดยตั้งใจ เพราะข้อกำหนดคือสมาชิกต้องได้รับอีเมล "อยู่ระหว่างดำเนินการ" **ครั้งเดียว** ไม่ว่าทางไหนมาก่อนหรือมากี่ครั้ง (หัวข้อ 34 และ 56) ซึ่งตรวจสอบได้เมื่อทั้งสองทางผ่าน guard เดียวกัน

guard นั้นคือ compare-and-set ของ state machine — **เฉพาะผู้เรียกที่ transition ได้ `APPLIED` เท่านั้นที่ส่งอีเมล** `email.opened` สิบครั้งกับการกดปุ่มแทรกกลางจึงได้อีเมลหนึ่งฉบับ ทางเลือกอื่นคืออ่านสถานะแล้วตัดสิน ซึ่งมีช่องว่างระหว่างการอ่านกับการเขียนที่ทำให้ผู้เรียกทั้งสองเห็นค่าเดียวกัน (test ยืนยันด้วยการยิงพร้อมกัน และการเปลี่ยน guard ให้หลวมทำให้ test fail ด้วยอีเมลสองฉบับ)

อีเมลที่ส่งไม่สำเร็จไม่ย้อนสถานะกลับ ผู้จัดการเริ่มงานไปแล้วจริง การ rollback เพื่อรายงานข้อเท็จจริงหนึ่งจะทำให้เสียข้อเท็จจริงอีกอันไป — แถวอีเมลยังอยู่ให้ retry ได้

## Post-payment workflow

หลังเงินยืนยันแล้ว ผู้สมัครไม่ต้องกด submit อีก (หัวข้อ 28) ระบบเดินต่อเองตามลำดับ:

```text
PAYMENT_VERIFIED → ออกเลขที่ใบสมัคร → RECEIPT_ISSUED
  → RECEIPT_EMAIL_SENT → APPLICATION_SUBMITTED → MANAGER_EMAIL_SENT
```

เลขที่ใบสมัครมาก่อนใบเสร็จ เพราะทั้งใบเสร็จและอีเมลทั้งสองฉบับพิมพ์เลขนี้ ถ้าออกใบเสร็จก่อน เอกสารที่สมาชิกเก็บไว้จะขึ้นว่า "ยังไม่ออกเลขที่ใบสมัคร"

**ไม่มีคอลัมน์ `current_step`** แต่ละขั้นตัดสินว่าตัวเองเสร็จแล้วหรือยัง จากสิ่งที่มันควรจะสร้างไว้ — เลขที่บนแถว, ใบเสร็จของใบสมัครนี้, อีเมลชนิดนั้นที่ provider รับแล้ว, หรือสถานะเอง คอลัมน์บอกความคืบหน้าคือแหล่งความจริงที่สองซึ่งขัดกับแหล่งแรกได้ และแหล่งแรกคือแหล่งที่นับ

**ขั้นที่ล้มเหลวไม่ล้มขั้นก่อนหน้า** ตอนนี้สมาคมมีเงินแล้ว ถ้า Resend ล่ม ใบเสร็จยังออก ใบสมัครยังถูก submit และแถวอีเมลถือความล้มเหลวของตัวเองไว้ให้ retry `resume` เริ่มต่อจากจุดที่ครั้งก่อนหยุดพอดี — provider ล่มจึงมีราคาเท่ากับการ retry ไม่ใช่การเสียการชำระเงิน

`MANAGER_NOTIFIED` ถูกบันทึกเฉพาะเมื่อ **อีเมลผู้จัดการถูกรับจริง** เพราะสถานะนี้บอกว่า "แจ้งผู้จัดการแล้ว" และ #14 ใช้สถานะนี้เป็นฐานของการนับ open ถ้าบันทึกหลังส่งไม่สำเร็จ ใบสมัครที่ยังไม่มีใครเห็นจะดูเหมือนถูกจัดการแล้ว

### จุดที่ยิงพร้อมกันได้

`resume` สองครั้งพร้อมกันจะอ่านว่า "ยังไม่มีอีเมลชนิดนี้" ทั้งคู่ ฝ่ายที่แพ้ `UNIQUE(application_id, type)` (migration 0004) จะ **ส่งไปที่แถวที่ชนะ** ไม่ใช่สร้างแถวใหม่ ทั้งคู่จึงใช้ idempotency key เดียวกันและ Resend คืน message เดิม ผู้รับได้อีเมลฉบับเดียว (test พิสูจน์ด้วยการเอา migration ออกแล้ว test fail ด้วยสองแถว)

### Endpoint

- `POST /api/payment/verify` รัน workflow ต่อทันทีหลัง commit การยืนยัน แล้วคืนสถานะแต่ละขั้นมาด้วย
- `GET /api/applications/:id/confirmation` อ่านสถานะแต่ละขั้น (หัวข้อ 66) **อ่านอย่างเดียว** — การ resume จาก GET จะทำให้การ refresh หน้า, prefetch หรือ link preview ส่งอีเมลได้
- `POST /api/applications/:id/finalize` เดินขั้นที่ค้างให้จบ ใช้ capability token เดิมกับที่ยืนยันการชำระเงิน และมี rate limit เพราะเรียก provider ได้ ฝั่งผู้จัดการจะได้ action เทียบเท่าที่ไม่ต้องใช้ token ของผู้สมัครใน #16

## Admin

**ทุก route ตรวจ Access JWT ในตัว Worker เอง ไม่ใช่พึ่งการตั้งค่าที่ edge เท่านั้น** Access ที่วางไว้หน้า `/admin*` และ `/api/admin/*` คือ setting เดียวใน dashboard — ถ้ามันถูกลบ, ถูกผูกกับ hostname ผิด หรือ path ไม่ตรง ทุก endpoint จะกลายเป็นสาธารณะทันที การตรวจซ้ำในนี้ทำให้ความผิดพลาดใน dashboard มีราคาเท่ากับ downtime ไม่ใช่ข้อมูลรั่ว

Token เป็น JWT ที่เซ็นด้วย RS256 ตรวจ signature กับ certificate ของทีม (`/cdn-cgi/access/certs`) แล้วตรวจ claim: `iss` ต้องเป็นทีมนี้, `aud` ต้องเป็น **application นี้** — ข้อนี้สำคัญที่สุด เพราะถ้าไม่ตรวจ token ที่ออกให้ application อื่นในบัญชีเดียวกันจะใช้ที่นี่ได้ — และช่วงเวลาต้องยังไม่หมดอายุ `alg` ถูกกำหนดเป็น RS256 ไม่อ่านจาก token เพราะการอ่านจาก token เปิดทาง `alg: none` และการใช้ public key เป็น shared secret

ค่า tolerance ของนาฬิกาใช้กับ `nbf` และ `iat` เท่านั้น ไม่ใช้กับ `exp` — การผ่อนที่ `exp` คือการต่ออายุ token ที่หมดแล้ว และ Access token มีอายุเป็นชั่วโมงอยู่แล้วจึงไม่ต้องผ่อน

ทุกความล้มเหลวตอบข้อความเดียวกัน ผู้เรียกรู้แค่ว่าเข้าได้หรือไม่ได้ ไม่รู้ว่าด่านไหนปฏิเสธ — ความต่างระหว่าง "aud ผิด" กับ "หมดอายุ" คือสิ่งที่คนกำลังลองเจาะอยากรู้พอดี

ถ้า certificate endpoint ติดต่อไม่ได้ ระบบ **ปฏิเสธทุกคำขอ** การ fail open ตอน outage คือการเปิด admin API ให้สาธารณะ

### GET ไม่เปลี่ยนสถานะ เด็ดขาด

Email security scanner เปิด URL ในอีเมลเอง ถ้า `GET` เปลี่ยนสถานะได้ gateway ป้องกันไวรัสจะกดรับเรื่องหรือกดยืนยันการบันทึกทะเบียนแทนผู้จัดการ (หัวข้อ 37) ทุกการเปลี่ยนสถานะจึงเป็น `POST` และต้องผ่าน origin check กับ double-submit CSRF token เพิ่ม เพราะ Access authenticate ด้วย cookie และ cookie ถูกส่งไปกับ cross-site request ด้วย

link ในอีเมลผู้จัดการชี้ไปหน้าใน portal ไม่ใช่ endpoint เหล่านี้ — หน้านั้นแสดงว่ากำลังจะเกิดอะไรแล้ว POST จากที่นั่น

### เลขบัตรประชาชนกับการ audit

`admin-view.ts` เป็นที่เดียวใน admin flow ที่ถอดรหัสเลขบัตร และมันบันทึก `CITIZEN_ID_ACCESSED` ในการเรียกเดียวกัน จึงไม่มีทางเพิ่มผู้อ่านคนที่สองภายหลังแล้วลืมบันทึก ทุกครั้งที่เปิดหน้ารายละเอียดถูกนับหนึ่งครั้ง — trail จึงตอบได้ว่าใครดูกี่ครั้ง

list view ไม่มีข้อมูลส่วนบุคคลเกินชื่อ ผู้จัดการที่ไล่ดูคิวงานไม่ต้องใช้ที่อยู่หรือเบอร์โทร และ list endpoint คือตัวที่มีโอกาสถูก log, cache หรือถ่ายจอมากที่สุด

รูปสมาชิกส่งผ่าน Worker ที่ authenticate แล้วเท่านั้น ไม่มี signed URL — URL ที่ใช้ได้โดยไม่ผ่าน Access จะอยู่นานกว่า session ของผู้จัดการและถูก forward ได้ (หัวข้อ 14)

### บันทึกทะเบียน กสทช.

`nbtc-completion.ts` มีรูปเดียวกับ post-payment workflow และด้วยเหตุผลเดียวกัน:

```text
NBTC_RECORDED → MEMBER_COMPLETION_EMAIL_SENT → COMPLETED
```

`COMPLETED` บันทึกเมื่อสมาชิกได้รับแจ้งแล้วเท่านั้น เพราะนั่นคือสิ่งที่สถานะนี้อ้าง ถ้าอีเมลล้ม การบันทึกทะเบียนยังอยู่ (`NBTC_RECORDED`) และการเรียกซ้ำจะทำเฉพาะส่วนที่ยังขาด ตัวตนผู้จัดการถูกเก็บใน `nbtc_recorded_by` และใน audit event — เป็นที่เดียวที่ระบบเก็บตัวตนของเจ้าหน้าที่ และจำเป็น เพราะการบันทึกทะเบียนกับหน่วยงานกำกับต้องระบุได้ว่าใครทำ

## Applicant wizard

เก้าขั้นตอนใน single page เดียว ตั้งแต่ privacy notice ถึงหน้า confirmation คอลัมน์เดียวทุกความกว้าง — layout ที่ใช้ได้บนมือถือ 360px ก็ใช้ได้บน desktop โดยขยายขอบ ไม่ต้อง reflow

**ไม่มีการเก็บอะไรลง client storage เลย** ไม่ `localStorage` ไม่ `sessionStorage` ไม่ IndexedDB state ถือเลขบัตรประชาชน, ภาพบัตร, ภาพใบหน้า, ภาพสลิป และ capability token ที่ป้องกันใบสมัครทั้งใบ storage อยู่นานกว่า tab, ถูกอ่านได้โดย script ใดก็ตามที่เคยรันบน origin นี้ และถูกเขียนลงดิสก์ การ refresh แล้วฟอร์มหายคือราคาที่จ่าย และเป็นราคาที่ถูก (test ยืนยันว่า storage ว่างเปล่าทั้งตอนสำเร็จและตอน error)

ภาพบัตรถูกทิ้งทันทีที่ OCR คืนค่า ไม่ถือไว้ตลอด wizard และผลจาก OCR ถือเป็น **pre-fill ไม่ใช่ผลลัพธ์** — ทุกช่องแก้ได้รวมทั้งเลขบัตร และข้อความบอกให้เทียบกับบัตรตัวจริงทีละช่อง (หัวข้อ 7)

ทางเลือก "กรอกข้อมูลเองแทน" อยู่ตั้งแต่ต้น ไม่ใช่โผล่มาหลัง OCR ล้ม — OCR บนภาพถ่ายบัตรที่สึกล้มบ่อยพอที่การซ่อนทางเลือกไว้จะทำให้ผู้สมัครบางคนติดอยู่ที่ขั้นที่สอง และบัตรประชาชนไม่ใช่เอกสารที่คนอยากถ่ายห้ารอบ

### รูปสมาชิก

ภาพใบหน้าจากบัตรถูก **เสนอ ไม่ใช่ถือว่ายินยอม** เลือกแล้วต้องติ๊ก consent แยกอีกช่อง และปุ่มยืนยันยังกดไม่ได้จนติ๊ก (หัวข้อ 61) การสลับไปอัปโหลดรูปใหม่จะล้าง consent ทิ้ง เพื่อไม่ให้ consent ค้างอยู่กับทางเลือกที่ผู้สมัครยกเลิกไปแล้ว

checklist ยืนยันเป็นสามข้อ ไม่ใช่ข้อเดียว เพราะ "ยืนยันว่ารูปนี้ใช้ได้" คือช่องที่คนติ๊กโดยไม่อ่าน แต่ "เห็นใบหน้าชัด", "ไม่สวมหมวกหรือแว่นกันแดด" และ "ถ่ายไม่นานและเป็นรูปของตัวเอง" คือสามอย่างที่ต้องมองจริง (หัวข้อ 12)

การ crop ทำบน canvas ซึ่งมีผลพลอยได้: output เป็น pixel ที่ encode ใหม่ EXIF และพิกัด GPS จึงไม่รอด — server ก็ strip metadata อยู่แล้ว แต่แบบนี้ข้อมูลไม่ออกจากเครื่องตั้งแต่แรก ตัวควบคุม crop ใช้ได้ด้วยคีย์บอร์ด (ปุ่มลูกศรเลื่อน, slider ย่อขยาย) เพราะเป็นขั้นที่ข้ามไม่ได้

### สลิป

เบราว์เซอร์อ่าน QR เองเป็นทางหลัก และเมื่ออ่านได้ **ภาพไม่ถูกถือไว้ด้วยซ้ำ** ส่งแค่ payload (หัวข้อ 18) `BarcodeDetector` มาก่อนเพราะเป็น decoder ของ platform เองและทนภาพถ่ายได้ดีกว่า jsQR เป็น fallback สำหรับเบราว์เซอร์ที่ยังไม่มี การอัปโหลดภาพเป็น fallback ชั้นสุดท้ายสำหรับสลิปที่ QR อ่านไม่ออก และหน้าเว็บบอกเรื่องนี้ตรง ๆ กับผู้สมัคร เพราะคนระวังการอัปโหลดสลิปธนาคารอย่างสมเหตุสมผล

### การกันกดซ้ำ

ทุก request ผ่าน `run` ที่ปฏิเสธการเริ่ม request ที่สองระหว่างที่ยังมี request ค้าง เป็น ref ไม่ใช่ state เพราะต้องอ่านและเขียนได้ทันทีใน event เดียว ปุ่มที่ disabled เป็นการบอกคน ไม่ใช่ lock

ข้อจำกัดที่ตรวจไม่ได้ในสภาพแวดล้อม test: React flush `setBusy(true)` จบ event แรกก่อน click ที่สองมาถึง ปุ่มจึง disabled ไปแล้ว การเอา lock ออกจึงไม่ทำให้ test fail — test ยืนยัน **ผลลัพธ์** (กดสามครั้งได้ request เดียว) ไม่ใช่ว่ากลไกไหนทำให้เป็นเช่นนั้น lock คือการกันกรณีที่ pointer event สองอันมาถึงก่อน React render ซึ่ง jsdom สร้างไม่ได้

### Error ที่ผู้ใช้เห็น

`api/client.ts` แปลงทุกความล้มเหลวเป็นข้อความที่ผู้สมัครทำอะไรได้ API คืน code กับข้อความไทยที่เขียนไว้ให้ผู้สมัครอยู่แล้ว — ข้อความนั้นคือที่แสดง อย่างอื่น (network ล้ม, gateway error, body ที่ parse ไม่ได้) กลายเป็นข้อความไทยกลาง ๆ ที่นี่ ข้อความของ provider หรือ framework จึงไปถึงหน้าจอไม่ได้ (หัวข้อ 63)

### Accessibility

ทุก input ผ่าน component `Field` เดียว จึงทำให้ "ทุกช่องมี label" เป็นคุณสมบัติของโค้ด ไม่ใช่ความเคยชิน — error ผูกด้วย `aria-describedby` + `aria-invalid` + `role="alert"` และ required ทำเครื่องหมายทั้งด้วยสายตาและด้วย attribute เพราะดอกจันสีแดงมองไม่เห็นสำหรับ screen reader และสำหรับคนที่แยกสีไม่ได้

heading ของแต่ละขั้นถูก focus เมื่อเปลี่ยนขั้น เพราะใน wizard หน้าเดียวไม่มีอะไรประกาศการเปลี่ยนขั้น ผู้ใช้ screen reader ที่กด "ถัดไป" จะได้ยินความเงียบและต้องไปหาเองว่าอะไรเปลี่ยน

## Admin portal

หน้าเดียวกับ wizard คนละ path — `/admin*` เป็น portal ผู้จัดการ ที่เหลือเป็น wizard ผู้สมัคร แชร์ bundle เพราะแชร์ component กับ stylesheet และการแยก build สองชุดสำหรับระบบที่รับหนึ่งถึงสองใบสมัครต่อวันไม่คุ้ม แต่ไม่แชร์ข้อมูลกันเลย — portal ไม่ render ตอน wizard ทำงาน และ wizard ไม่ถือ state ของ admin

สิ่งแรกที่ portal ทำคือเรียก `GET /api/admin/session` ซึ่งทำสองอย่างพร้อมกัน: พิสูจน์ว่าผู้เรียกผ่าน Access แล้ว และคืน CSRF token ที่ทุกการเปลี่ยนสถานะต้องแนบ **ถ้าเรียกไม่ผ่าน ไม่ render หน้าใดเลย** ไม่มีสถานะ "ใช้ได้บางส่วน" — ไม่มี CSRF token ก็ยืนยันอะไรไม่ได้อยู่แล้ว และ portal ที่ดูเหมือนทำงานได้แต่ทุก action ล้มเหลวแย่กว่าการบอกตรง ๆ

### เลขบัตรประชาชนแยกเป็น request ของตัวเอง

เดิม (#16) หน้า detail ถอดรหัสเลขบัตรตอนโหลด ทำให้ทุกครั้งที่ผู้จัดการเปิดดูใบสมัครเกิด `CITIZEN_ID_ACCESSED` — audit trail จึงแยกไม่ออกระหว่าง "ผู้จัดการเปิดดูเลขบัตร" กับ "ผู้จัดการเปิดหน้า"

ตอนนี้เลขบัตร**ไม่อยู่ใน detail เลย** และมี `GET /api/admin/applications/:id/citizen-id` แยก ผู้จัดการต้องกดปุ่มเพื่อเปิดดู หน้าเว็บบอกด้วยว่าการเปิดดูจะถูกบันทึก ผลคือ entry ใน trail หมายถึงมีคนถามหาเลขจริง ๆ และเลขไม่ค้างอยู่บนจอให้ถูกถ่ายภาพโดยไม่ได้ตั้งใจ

### GET ไม่เปลี่ยนอะไร และหน้ายืนยันรู้สถานะก่อน

link ในอีเมลผู้จัดการชี้มาที่ `/admin/applications/:id/acknowledge` และ `/nbtc-complete` ซึ่งเป็นหน้ายืนยัน ไม่ใช่ endpoint — email security scanner เปิด link เอง ถ้าหน้านั้นทำงานทันที gateway ป้องกันไวรัสจะกดรับเรื่องหรือแจ้งสมาชิกว่าบันทึกทะเบียนเสร็จแทนผู้จัดการ (หัวข้อ 37)

หน้ายืนยันโหลดใบสมัครก่อนแล้ว **ไม่เสนอ action ที่สถานะปัจจุบันทำไม่ได้** ถ้าเปิดอีเมลฉบับเก่าซ้ำ หน้าจะบอกว่าดำเนินการไปแล้ว แทนที่จะแสดงปุ่มที่กดแล้วล้มเหลว ซึ่งจะทำให้ผู้จัดการไม่รู้ว่าครั้งแรกสำเร็จหรือไม่

### รูปสมาชิกและใบเสร็จ

เป็น `<img src>` และ `<a href>` ชี้ไปที่ endpoint ที่ authenticate แล้วโดยตรง เบราว์เซอร์ส่ง Access cookie ให้เอง จึงไม่มี URL ที่เปิดได้โดยไม่ผ่าน Access และไม่มีอะไรให้ forward (หัวข้อ 14)

### เวลาและรายการคิว

ทุกเวลาแสดงเป็น Asia/Bangkok และปีพุทธศักราช ผู้จัดการอ่านมันข้างเอกสารที่พิมพ์ `2569` และวันเกิดที่ผู้สมัครกรอกมาจากบัตรที่พิมพ์แบบเดียวกัน `th-TH-u-ca-buddhist` ระบุปฏิทินไว้ตรง ๆ ไม่พึ่งว่า `th-TH` จะ default เป็นพุทธศักราช ซึ่งจริงใน ICU ปัจจุบันแต่ไม่ใช่การรับประกัน

รายการคิวเปิดที่ "ที่ต้องดำเนินการ" ไม่ใช่ทั้งหมด และแต่ละแถวมีแค่ชื่อ เลขที่ใบสมัคร ยอด และสถานะ — ไม่มีที่อยู่ ไม่มีเบอร์โทร ไม่มีเลขบัตร นี่เป็นหน้าที่มีโอกาสถูกเปิดค้างบนจอที่ใช้ร่วมกันหรือถูกถ่ายภาพมากที่สุด และข้อมูลเหล่านั้นไม่จำเป็นต่อการเลือกว่าจะเปิดใบไหน

## Decision records

การเปลี่ยน technology, trust boundary, data retention, state machine, schema หรือ deployment strategy ต้องอธิบายเหตุผลและ trade-offs ใน PR และเพิ่ม decision record ภายใต้ `docs/decisions/` เมื่อมีผลระยะยาว
