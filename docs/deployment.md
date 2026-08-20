# Deployment

Production target คือ Cloudflare Workers ที่ `member.vra.or.th` พร้อม D1, private R2, Turnstile และ Cloudflare Access

Pipeline ประกอบด้วยสาม workflow

| Workflow                                          | Trigger                           | หน้าที่                                                               |
| ------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| [`quality.yml`](../.github/workflows/quality.yml) | `workflow_call`                   | repository baseline + lint, format, typecheck, test, build (reusable) |
| [`ci.yml`](../.github/workflows/ci.yml)           | pull request, push `main`, manual | เรียก quality gates                                                   |
| [`deploy.yml`](../.github/workflows/deploy.yml)   | push `main`, manual               | เรียก quality gates แล้ว deploy production                            |

`deploy.yml` เรียก quality gates ชุดเดียวกับ CI และ job `deploy` มี `needs: quality` จึงไม่มีทางที่ commit จะขึ้น production โดยไม่ผ่าน gates เดียวกัน และใช้ GitHub environment ชื่อ `production` เพื่อบังคับ approval/secret scoping

## One-time setup by the Cloudflare account owner

ขั้นตอนเหล่านี้ต้องทำโดยผู้ดูแลที่มีสิทธิ์ในบัญชี Cloudflare และ repository ไม่สามารถทำจาก CI ได้

1. ~~สร้าง D1 database สองชุด~~ **เสร็จแล้ว** `vra-membership-dev` และ `vra-membership-prod` ถูกสร้างและ `database_id` อยู่ใน `wrangler.jsonc` แล้ว

2. ~~สร้าง R2 bucket แบบ private สองชุด~~ **เสร็จแล้ว** `vra-member-private-dev` และ `vra-member-private` ถูกสร้างแล้ว ตรวจยืนยันว่า public access ผ่าน `r2.dev` ปิดอยู่และไม่มี custom domain ผูกไว้

   ตรวจซ้ำได้ด้วย

   ```bash
   npx wrangler r2 bucket dev-url get vra-member-private
   npx wrangler r2 bucket domain list vra-member-private
   ```

3. ผูก custom domain `member.vra.or.th` เข้ากับ Worker `vra-membership`

4. ตั้ง Cloudflare Secrets สำหรับ production ผ่าน `wrangler secret put <NAME> --env production`

   | Secret                  | ใช้ทำอะไร                         |
   | ----------------------- | --------------------------------- |
   | `IAPP_API_KEY`          | iApp Thai national ID OCR         |
   | `SLIPOK_API_KEY`        | SlipOK slip verification          |
   | `RESEND_API_KEY`        | Resend transactional email        |
   | `RESEND_WEBHOOK_SECRET` | ตรวจ signature ของ Resend webhook |
   | `TURNSTILE_SECRET_KEY`  | ตรวจ Turnstile token ฝั่ง server  |
   | `PII_ENCRYPTION_KEY`    | เข้ารหัสเลขบัตรประชาชนใน D1       |
   | `MANAGER_EMAIL`         | ผู้รับ email แจ้งใบสมัครใหม่      |
   | `EMAIL_FROM`            | sender ของ transactional email    |
   | `VRA_BANK_NAME`         | แสดงบนหน้าชำระเงินและใช้ตรวจสลิป  |
   | `VRA_BANK_ACCOUNT`      | แสดงบนหน้าชำระเงินและใช้ตรวจสลิป  |
   | `VRA_BANK_ACCOUNT_NAME` | แสดงบนหน้าชำระเงินและใช้ตรวจสลิป  |

   `PII_ENCRYPTION_KEY` ต้องเป็นค่าสุ่มความยาวอย่างน้อย 32 bytes สร้างด้วย

   ```bash
   openssl rand -base64 48
   ```

   ระบบใช้ไบต์ของสตริงนี้เป็น input ของ HKDF โดยตรง ไม่มีการ decode base64 ดังนั้นต้องใช้ค่าเดิมทั้งสตริงตลอดอายุของข้อมูล การเปลี่ยนค่านี้ทำให้ ciphertext และ hash ที่มีอยู่ใช้ไม่ได้ จึงต้องมีแผน re-encrypt ก่อน rotate ทุกครั้ง

   ค่าทั้งหมดตั้งผ่าน Cloudflare เท่านั้น ห้ามใส่ใน `wrangler.jsonc`, Issue, PR หรือ log แม้ข้อมูลบัญชีธนาคารจะเผยแพร่ต่อผู้สมัครก็ไม่เก็บลง repository

5. สร้าง Cloudflare Access application ครอบ `/admin*` และ `/api/admin/*` แล้วกำหนดผู้ใช้ที่เข้าได้

6. สร้าง Turnstile site แล้วเก็บ secret key เป็น Cloudflare Secret ชื่อ `TURNSTILE_SECRET_KEY` ส่วน site key เป็นค่าสาธารณะที่อยู่ใน client bundle

   เพิ่ม Cloudflare rate limiting rule ที่ระดับ edge สำหรับ `/api/ocr`, `/api/payment/verify` และ `/api/member-photo` ด้วย ระบบมี rate limiting ใน application layer อยู่แล้ว แต่ rule ที่ edge หยุด traffic ก่อนถึง Worker จึงกันทั้งค่า Worker invocation และค่า D1 write ที่ counter ใช้

7. สร้าง GitHub environment ชื่อ `production` (Settings -> Environments) โดยเปิด required reviewers และจำกัด deployment branch เป็น `main` แล้วเพิ่ม environment secrets

   | Secret                  | หมายเหตุ                                                                              |
   | ----------------------- | ------------------------------------------------------------------------------------- |
   | `CLOUDFLARE_API_TOKEN`  | least privilege: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit เฉพาะบัญชีนี้ |
   | `CLOUDFLARE_ACCOUNT_ID` | account id ที่ใช้ deploy                                                              |

8. เปิด delivery ด้วย repository variable `CLOUDFLARE_DEPLOY_ENABLED=true`

   ก่อนตั้งค่านี้ job `deploy` จะข้ามขั้นตอน deploy และเขียนสรุปว่ายังไม่เปิด delivery เพื่อไม่ให้ push เข้า `main` ล้มเหลวก่อนที่ทรัพยากรจะพร้อม

## Deployment sequence

`deploy.yml` ทำตามลำดับนี้

1. quality gates (baseline, lint, format, typecheck, test, build, production config dry-run)
2. ตรวจว่า environment secrets ที่จำเป็นมีอยู่จริง
3. `npm run build:web`
4. `wrangler d1 migrations apply DB --env production --remote`
5. `wrangler deploy --env production`
6. smoke test `GET https://member.vra.or.th/api/health` ต้องได้ HTTP 200 (endpoint นี้ไม่มี PII และไม่เรียก provider)
7. บันทึก commit SHA และ URL ไว้ใน job summary

## Rollback

Migration ของ D1 เป็น append-only ดังนั้น rollback ของ code และ rollback ของ schema แยกกัน

### Rollback ของ Worker

ทางที่เร็วที่สุดคือใช้ deployment ก่อนหน้าของ Cloudflare

```bash
npx wrangler deployments list --env production
npx wrangler rollback <DEPLOYMENT_ID> --env production
```

ตรวจ `GET /api/health` อีกครั้งหลัง rollback

ถ้าต้องการย้อนผ่าน Git ให้ `git revert` commit ที่มีปัญหาบน `main` แล้วให้ pipeline deploy ใหม่ ห้าม force push `main`

### Rollback ของ schema

ห้ามลบหรือแก้ migration ที่ apply บน production แล้ว ให้เขียน forward-fix migration ใหม่แทน ทุก PR ที่แตะ schema ต้องระบุ forward-fix path ไว้ใน PR

ถ้า Worker ใหม่ต้องใช้ column ที่ยังไม่มี ให้ deploy migration ก่อน code เสมอ (`deploy.yml` apply migration ก่อน `wrangler deploy` อยู่แล้ว) และให้ migration เป็นแบบ backward compatible เพื่อให้ rollback ของ code ทำงานได้กับ schema ใหม่

### เมื่อข้อมูลเสียหาย

ใช้ D1 time travel เพื่อกู้ถึงจุดเวลาที่ต้องการ

```bash
npx wrangler d1 time-travel info vra-membership-prod
npx wrangler d1 time-travel restore vra-membership-prod --timestamp <ISO8601>
```

การกู้ข้อมูลแตะข้อมูลส่วนบุคคล จึงต้องมีผู้ดูแลที่เป็นมนุษย์อนุมัติและบันทึกเหตุผลไว้ใน Issue โดยไม่แนบข้อมูลจริง

## Rules

- Deploy เฉพาะ commit บน `main` ที่ผ่าน quality gates
- ห้าม deploy จาก PR ของ fork และห้าม expose deployment secrets ให้ workflow ที่ทำงานบน PR
- ห้ามรัน automated test กับ provider จริง หรือใช้ production key ใน CI
- Smoke test ห้ามใช้ข้อมูลจริงของสมาชิก
