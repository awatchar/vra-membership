# Owner actions

สิ่งที่ต้องทำโดยผู้ดูแลที่มีสิทธิ์ในบัญชี Cloudflare และ repository เท่านั้น งานพัฒนาที่เหลือทั้งหมดไม่ถูกบล็อกโดยรายการนี้ ยกเว้น [#19](https://github.com/awatchar/vra-membership/issues/19) ที่ต้อง deploy จริง

เอกสารนี้เป็นแหล่งอ้างอิงเดียวของรายการเหล่านี้ อัปเดตทุกครั้งที่มีรายการเพิ่มหรือเสร็จ

---

## 1. Cloudflare Secrets — ต้องทำก่อน deploy ครั้งแรก

ใช้สคริปต์ที่เตรียมไว้ กรอกค่าลงไฟล์เดียวแล้วรันครั้งเดียว ค่าไม่ผ่าน command line และไม่ค้างใน shell history

```powershell
# 1. สร้าง template
pwsh -File ./scripts/set-production-secrets.ps1 -CreateTemplate

# 2. กรอกค่าใน .secrets/production.env (ไฟล์นี้ถูก git-ignore)

# 3. ตรวจว่าครบก่อนอัปโหลดจริง
pwsh -File ./scripts/set-production-secrets.ps1 -WhatIf

# 4. อัปโหลด
pwsh -File ./scripts/set-production-secrets.ps1
```

| Secret                                                       | ได้จากไหน                                    |
| ------------------------------------------------------------ | -------------------------------------------- |
| `IAPP_API_KEY`                                               | บัญชี iApp                                   |
| `SLIPOK_API_KEY`                                             | บัญชี SlipOK                                 |
| `SLIPOK_BRANCH_ID`                                           | SlipOK — branch id ที่อยู่ใน endpoint path   |
| `RESEND_API_KEY`                                             | บัญชี Resend                                 |
| `RESEND_WEBHOOK_SECRET`                                      | Resend → Webhooks → signing secret           |
| `TURNSTILE_SECRET_KEY`                                       | Cloudflare → Turnstile → widget ที่สร้างใหม่ |
| `PII_ENCRYPTION_KEY`                                         | ปล่อยว่างไว้ สคริปต์สร้างให้                 |
| `MANAGER_EMAIL`                                              | email ผู้จัดการสมาคม                         |
| `EMAIL_FROM`                                                 | sender ของ transactional email               |
| `VRA_BANK_NAME`, `VRA_BANK_ACCOUNT`, `VRA_BANK_ACCOUNT_NAME` | ข้อมูลบัญชีสมาคม                             |
| `EMAIL_FROM_TRACKED` (ไม่บังคับ)                             | sender แยกสำหรับ open tracking — ดูข้อ 2     |

> **`PII_ENCRYPTION_KEY` เปลี่ยนไม่ได้หลังมีข้อมูลจริง** ciphertext ของเลขบัตรและ hash ที่ใช้ค้นหาซ้ำ derive จาก key นี้ทั้งคู่ และไม่มีสำเนา plaintext เก็บไว้ที่ไหนเลย **สำรอง key ไว้ที่ปลอดภัยและออฟไลน์ก่อนลบไฟล์ค่า** ถ้า key หาย เลขบัตรทุกใบอ่านไม่ได้อีกเลย
>
> สคริปต์จะปฏิเสธการลบไฟล์ค่าเมื่อมันเป็นคนสร้าง key ให้ แม้สั่ง `-RemoveFileWhenDone` เพราะคุณยังไม่ได้สำรอง

---

## 2. Cloudflare — การตั้งค่าอื่น

- [ ] **Turnstile site** — สร้าง widget เก็บ secret key ไว้ใส่ในข้อ 1 ส่วน site key เป็นค่าสาธารณะที่จะใส่ใน client build (#17)
- [ ] **Custom domain** — ผูก `member.vra.or.th` เข้ากับ Worker `vra-membership` (`wrangler.jsonc` ประกาศ route ไว้แล้ว จะถูกสร้างตอน deploy ครั้งแรก แต่ DNS ต้องพร้อม)
- [ ] **Cloudflare Access application** — ครอบ `/admin*` และ `/api/admin/*` กำหนดผู้ใช้ที่เข้าได้ (ผู้จัดการสมาคม + ผู้ดูแล) ใช้จริงเมื่อ #16 เสร็จ
- [ ] **Edge rate limiting rule** — สำหรับ `/api/ocr`, `/api/payment/verify`, `/api/member-photo` ระบบมี rate limiting ใน application layer อยู่แล้ว แต่ rule ที่ edge หยุด traffic ก่อนถึง Worker จึงกันทั้งค่า invocation และค่า D1 write ที่ counter ใช้
- [ ] **Resend — endpoint ของ webhook** — เพิ่ม endpoint `https://member.vra.or.th/api/webhooks/resend` แล้วเลือก event `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced` จากนั้นคัดลอก signing secret ไปใส่ `RESEND_WEBHOOK_SECRET` ในข้อ 1
      ระบบตอบ 2xx ให้ event ที่ไม่ได้เลือกด้วย จึงเลือกเพิ่มได้โดยไม่พัง แต่ **การเปลี่ยนสถานะใบสมัครอาศัย `email.opened`** ถ้าไม่เลือก ผู้จัดการต้องกดปุ่ม "รับเรื่อง / เริ่มดำเนินการ" เอง
- [ ] **Resend — open tracking แยก sender (ไม่บังคับ)** — Resend เปิด open tracking ที่ระดับ domain ไม่มี field ต่อ message ถ้าเปิดบน domain ที่ส่งอีเมลสมาชิก อีเมลสมาชิกจะถูก track ด้วย ซึ่งขัดกับข้อกำหนดที่ให้ track เฉพาะอีเมลผู้จัดการ วิธีที่ตรงตามข้อกำหนดคือ verify subdomain แยก (เช่น `notify.vra.or.th`) เปิด open tracking บน subdomain นั้น แล้วใส่เป็น `EMAIL_FROM_TRACKED`
      **ถ้าไม่ทำ** ระบบยังทำงานครบ เพียงแต่การที่ผู้จัดการเปิดอีเมลจะไม่ขยับสถานะใบสมัครเอง ผู้จัดการต้องกดปุ่ม "รับเรื่อง / เริ่มดำเนินการ" ซึ่งมีอยู่ในอีเมลและในระบบผู้จัดการแล้ว
- [ ] **API token สำหรับ CI** — สร้างแบบ least privilege: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit เฉพาะบัญชีนี้ ต้องเป็น token แยกจาก CLI session ที่ใช้ provisioning

---

## 3. GitHub

- [ ] เพิ่ม environment secrets บน environment `production`: `CLOUDFLARE_API_TOKEN` และ `CLOUDFLARE_ACCOUNT_ID`
- [ ] ตั้ง repository variable `CLOUDFLARE_DEPLOY_ENABLED=true` เมื่อข้อ 1 และ 2 เสร็จ ก่อนหน้านั้น job `deploy` จะข้ามขั้นตอน deploy และเขียนสรุปว่ายังไม่เปิด delivery
- [ ] **GitHub Support request** เพื่อ purge PII ที่ยังเข้าถึงได้ผ่าน commit SHA เดิม — รายละเอียดใน [#21](https://github.com/awatchar/vra-membership/issues/21)

---

## 4. การตัดสินใจที่ต้องทำก่อนมีข้อมูลจริง

- [ ] **Data residency** — D1 และ R2 ถูกสร้างที่ **APAC** ซึ่ง Cloudflare เลือกให้ ไม่ได้ pin ไว้ ถ้ามีข้อกำหนดเรื่องที่ตั้งข้อมูล ต้องตัดสินใจตอนนี้ เพราะย้าย location ทีหลังไม่ได้
- [ ] **Environment protection rules** — ตอนนี้ environment `production` มี required reviewer และจำกัด branch เป็น `main` แล้ว (ใช้ได้หลัง repo เป็น public) ถ้าจะกลับเป็น private ต้องอัปเกรดแผนหรือยอมเสีย protection rules ไป
- [ ] **Retention policy** — ต้องกำหนดว่าเก็บข้อมูลใบสมัคร รูปสมาชิก และ audit events นานเท่าไร และลบอย่างไร เป็นส่วนหนึ่งของ [#19](https://github.com/awatchar/vra-membership/issues/19)
- [ ] **แจ้งผู้จัดการสมาคม** ว่าชื่อและ email ของท่านเคยปรากฏใน public repository ช่วงเวลาหนึ่ง (ดู [#21](https://github.com/awatchar/vra-membership/issues/21))

---

## 5. รายการที่ต้องตรวจกับของจริง ไม่ใช่เอกสาร

รวมอยู่ใน [#19](https://github.com/awatchar/vra-membership/issues/19) แล้ว บันทึกไว้ที่นี่เพื่อไม่ให้ลืม

- [ ] **iApp upload limit** — เอกสารขัดแย้งกันเอง หน้าหนึ่งบอก 10 MB อีกที่บอก 413 ที่ 2 MB ระบบตั้งเพดานไว้ 2 MB ตามค่าที่เข้มกว่า ตรวจกับ API จริง
- [ ] **iApp response mapping** — ชื่อ field รูปแบบวันที่ และการเข้ารหัสของ `face` มาจากเอกสาร ไม่ใช่จากการเรียกจริง ตรวจตอนอ่านบัตรใบจริงครั้งแรก
- [ ] **`CF-Connecting-IP`** — ต้องมีบน production ถ้าไม่มี rate limiting จะรวมทุกคนเป็น bucket เดียว ซึ่งเข้มกว่าแต่ทำให้ผู้ใช้จริงกระทบกัน
- [ ] **สัดส่วนรูปสมาชิก** — tolerance 0.02 ตรวจว่าการครอบตัดจาก browser จริงอยู่ในช่วงนี้
- [ ] **ขนาดรูปต่ำสุด 300x400** — ตรวจว่าพิมพ์บนบัตรได้จริง
- [ ] **การจับคู่บัญชีผู้รับ** — ธนาคารปิดบังเลขบัญชีไว้บางส่วน และปิดบังต่างกันตามธนาคาร ระบบตรวจว่าเลขที่มองเห็นเรียงอยู่ในเลขบัญชีของสมาคม ตรวจกับสลิปจริงจากธนาคารที่สมาชิกใช้บ่อยว่ามีเลขให้เห็นอย่างน้อย 4 หลัก ถ้าน้อยกว่านั้นระบบจะปฏิเสธแบบ `RECEIVER_UNVERIFIABLE` แทนที่จะเดา
- [ ] **PromptPay QR** — สแกนด้วยแอปธนาคารจริงแล้วยืนยันว่าปลายทางและยอดถูกต้อง ก่อนเปิดใช้กับผู้สมัครจริง
- [ ] **หน้าต่างเวลา 7 วัน** — สลิปที่เก่ากว่านี้ถูกปฏิเสธ ตรวจว่าเหมาะกับพฤติกรรมจริงของผู้สมัคร

---

## เสร็จแล้ว

- [x] สร้าง D1 `vra-membership-dev` และ `vra-membership-prod` พร้อมใส่ `database_id` ลง `wrangler.jsonc` ([#26](https://github.com/awatchar/vra-membership/pull/26))
- [x] สร้าง R2 `vra-member-private-dev` และ `vra-member-private` และยืนยันว่า public access ปิดและไม่มี custom domain
- [x] Apply migration เข้า D1 ของ dev เพื่อทดสอบ SQL กับ D1 จริง
- [x] สร้าง GitHub environment `production` พร้อม required reviewer และ branch policy `main`
- [x] เปิด branch ruleset บน `main`: ห้ามลบ ห้าม force push ต้องผ่าน PR squash-only และต้องผ่าน CI ทั้งสอง check
- [x] เปิด secret scanning, push protection, Dependabot security updates และ private vulnerability reporting
- [x] ล้าง `manager-email.md` ออกจากประวัติ Git ของ `main` (ยังเหลือ GitHub Support request ในข้อ 3)
