# Security and Privacy Baseline

## Data classification

| Class              | Examples                                        | Repository / logs      |
| ------------------ | ----------------------------------------------- | ---------------------- |
| Secret             | API keys, webhook secrets, encryption keys      | Never                  |
| Restricted PII     | citizen ID, address, DOB, member photo          | Never                  |
| Ephemeral image    | full ID card, payment slip                      | Never persist          |
| Generated document | receipt PDF                                     | Never persist          |
| Internal metadata  | request ID, internal application ID, error code | Allowed when minimized |
| Public             | documentation, public branding assets           | Allowed                |

## Required controls

- Cloudflare Access ป้องกัน admin routes; ห้ามสร้าง password auth เองโดยไม่มี decision record
- Turnstile, validation, MIME/size checks และ rate limiting ป้องกัน public endpoints ที่มีค่าใช้จ่าย
- Webhooks ต้องตรวจ signature, replay protection และ idempotency
- Payment amount และ receiver ถูก resolve/validate ฝั่ง backend เท่านั้น
- Transaction reference, application number และ receipt number ต้อง unique/concurrency-safe
- R2 เป็น private; object keys เป็น random identifiers และไม่มี PII
- Logs ใช้ allowlist ของ technical metadata ไม่ dump object/request/provider response
- Receipt PDF สร้างใน memory และไม่เขียนลง storage; สิทธิ์ regenerate ต้องผ่าน admin authentication
- ทุก response มี Content-Security-Policy ที่ `default-src 'none'` และ **ไม่มี `unsafe-inline`/`unsafe-eval`** ที่ `script-src` — ดูหัวข้อ Response headers ด้านล่าง
- Retention และ deletion ต้องกำหนดก่อน production พร้อม audit trail ที่ไม่เก็บ payload ลับ

ทุก PR ต้องระบุ security/privacy impact แม้คำตอบคือ “ไม่มี” พร้อมเหตุผลสั้น ๆ

## Response headers

`src/worker/security/headers.ts` ตั้ง header บนทุก response และ middleware อยู่ชั้นนอกสุดใน `src/worker/index.ts` จึงครอบทั้ง API, error และ static asset — policy ที่ครอบเฉพาะ path ที่มีคนจำได้ ไม่ใช่ policy

Worker รันก่อน asset binding ทุก request (`run_worker_first: true`) เพื่อให้ตั้ง header บน HTML และ bundle ได้ ถ้าไม่ทำ เอกสารที่โหลด script จะเป็น response เดียวที่ไม่มี CSP

### ทำไม CSP สำคัญกับระบบนี้เป็นพิเศษ

CSRF protection ใน #8 (origin check + double-submit token) กัน cross-site request ได้ แต่ **ไม่กัน XSS** script ที่รันบน origin ของเราเองอ่าน cookie แล้วสร้าง header เองได้ ทำให้ทั้งสองด่านไม่มีผล และหน้าผู้จัดการแสดงเลขบัตรประชาชน ที่อยู่ และรูปสมาชิก XSS จึงเป็นทางเดียวที่เหลือไปถึงข้อมูลนั้น `script-src` ที่ไม่มี `unsafe-inline` และไม่มี `unsafe-eval` คือสิ่งที่ปิดทางนี้

### จุดที่ต้องรู้ก่อนแก้ policy

**inline style ของ React ไม่ถูกกระทบ** `style={{...}}` ถูกใช้ผ่าน CSSOM (`node.style.width = …`) และ CSP ควบคุม style _attribute_ กับ `<style>` ที่ parse จาก markup ไม่ใช่การเปลี่ยน style ด้วยโปรแกรม จึงใช้ `style-src 'self'` ได้โดยไม่ต้องยกเว้นให้ progress bar หรือกรอบ crop (ยืนยันในเบราว์เซอร์จริงแล้ว: `style.width` เป็น `11%` และไม่มี CSP violation)

**Turnstile ต้องการแค่สองอย่าง** `script-src` และ `frame-src` ของ `https://challenges.cloudflare.com` ตามเอกสาร Cloudflare ไม่ต้องมี inline allowance

**`camera=()` ปิดสนิท** ทั้งที่ wizard ถ่ายภาพ เพราะใช้ `<input type="file" capture>` ซึ่งส่งต่อให้แอปกล้องของระบบปฏิบัติการและไม่ต้องขอ permission ของเว็บ ต่างจาก `getUserMedia` ที่ระบบนี้ไม่ใช้เลย การเปิด feature นี้จะอนุญาตสิ่งที่ไม่มีใครต้องใช้

**`blob:` ใน `img-src`** จำเป็น เพราะภาพบัตร ภาพใบหน้า และภาพสลิปถูกแสดงจาก blob URL — ก็เพราะมันไม่ออกจากเครื่องผู้ใช้

### Cache-Control

`no-store` เป็นค่าตั้งต้นเมื่อ response ไม่ได้เลือกค่าของตัวเอง ทุก API route ที่คืนข้อมูลส่วนบุคคลตั้งไว้ชัดเจนอยู่แล้ว และตัวนี้เป็นตัวรับท้าย: route ที่เพิ่มมาภายหลังแล้วลืมตั้ง จะเป็น private โดยปริยาย ไม่ใช่ cacheable โดยปริยาย static asset มี `Cache-Control` ของตัวเองจาก asset binding จึงไม่ถูกทับ

### HSTS

`max-age=63072000; includeSubDomains; preload` ส่งเฉพาะบน HTTPS การส่งบน plain HTTP เบราว์เซอร์ไม่สนใจ และจะปรากฏเฉพาะใน local development ซึ่งจะ pin `localhost` เป็น HTTPS ในเบราว์เซอร์ของผู้พัฒนาไปสองปี
