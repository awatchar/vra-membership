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
  security/            controls applied before business rules run
    turnstile.ts       bot protection, verified before any provider call
    rate-limit.ts      fixed-window counters in D1, hashed identifiers
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
  providers/types.ts   OcrProvider, SlipVerificationProvider, EmailProvider
  providers/iapp/      Thai national ID OCR adapter; narrows the response
  providers/slipok/    payment slip verification adapter
  providers/mock/      deterministic adapters used by development and tests
assets/fonts/          Sarabun (OFL), vendored so a receipt never needs the network
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

## Decision records

การเปลี่ยน technology, trust boundary, data retention, state machine, schema หรือ deployment strategy ต้องอธิบายเหตุผลและ trade-offs ใน PR และเพิ่ม decision record ภายใต้ `docs/decisions/` เมื่อมีผลระยะยาว
