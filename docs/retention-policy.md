# Data retention and deletion policy

Policy owner: สมาคมนักวิทยุอาสาสมัคร<br>
System: VRA Membership Registration System<br>
Version: 1<br>
Effective date: 21 August 2026

หลักคือเก็บข้อมูลส่วนบุคคลเท่าที่จำเป็นต่อวัตถุประสงค์ และแยกอายุของ PII ออกจากอายุของหลักฐานทางบัญชี กรมสรรพากรอธิบายว่าบัญชีและเอกสารประกอบต้องเก็บอย่างน้อย 5 ปี และอาจถูกกำหนดให้เก็บได้ถึง 7 ปี ระบบจึงล้าง PII เร็ว แต่เก็บ accounting record ที่ไม่มี PII ไม่เกิน 7 ปีเป็นเพดานแบบอนุรักษนิยม

แหล่งอ้างอิง:

- [กรมสรรพากร: ระยะเวลาเก็บเอกสารตามพระราชบัญญัติการบัญชี](https://www.rd.go.th/25480.html)
- [กรมสรรพากร: มาตรา 87/3](https://www.rd.go.th/5209.html)
- [GPPC/PDPC: เก็บข้อมูลตลอดระยะเวลาที่จำเป็นตามวัตถุประสงค์](https://gppc.pdpc.or.th/privacy-policy/)

เอกสารนี้เป็นนโยบายปฏิบัติของระบบ ไม่ใช่คำวินิจฉัยทางกฎหมาย สมาคมต้องทบทวนเมื่อวัตถุประสงค์ กฎหมาย หรือกระบวนการทางบัญชีเปลี่ยน

## Schedule

| กลุ่มข้อมูล                                                                                 | Trigger                                 | การดำเนินการ                                                                                                                          | อายุสูงสุด                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| ภาพบัตรประชาชนทั้งใบ                                                                        | หลัง OCR                                | ไม่ persist; ทิ้งจาก request memory                                                                                                   | 0                                               |
| ภาพสลิป                                                                                     | หลัง QR decode/verification             | ไม่ persist; ทิ้งจาก request memory                                                                                                   | 0                                               |
| ใบสมัครค้างที่ไม่มี verified payment (`DRAFT`, `AWAITING_PAYMENT`, `CANCELLED`, `REJECTED`) | ไม่มีความเคลื่อนไหว                     | ลบ application, child rows และ private R2 photo                                                                                       | 30 วัน                                          |
| ใบสมัคร `COMPLETED` หรือ `REFUNDED`                                                         | งานเสร็จ                                | ล้าง citizen ID/hash, ชื่อ, วันเกิด, contact, address, capability, manager identity, email recipient/provider id และ private R2 photo | 90 วัน                                          |
| Reference/status/membership amount/payment/receipt และ audit metadata ที่ล้าง actor แล้ว    | วันที่ออก receipt หรือวันที่แก้ไขล่าสุด | ลบ application และ child rows ทั้งหมด                                                                                                 | 7 ปี                                            |
| Rate-limit counters                                                                         | จบ window                               | ลบ opportunistically เมื่อมี request ใหม่                                                                                             | ตาม window                                      |
| Worker logs                                                                                 | ตาม Cloudflare plan                     | ใช้เฉพาะ allowlisted technical metadata; ไม่ export เป็น archive ถาวร                                                                 | ค่า platform ที่สั้นที่สุดที่ operations ใช้ได้ |

สถานะที่ยังดำเนินการ (`PAYMENT_VERIFIED`, `SUBMITTED`, `MANAGER_NOTIFIED`, `NBTC_PROCESSING`, `REFUND_REQUIRED`) ไม่ถูกลบอัตโนมัติ ให้ operations ตรวจรายการค้างและแก้ workflow ก่อน

## Implementation

- Migration `0005_add_retention_state.sql` เพิ่ม `pii_erased_at` และ `retention_hold_until`
- production Cron ทำงานทุกวัน 02:17 Asia/Bangkok
- Cleanup จำกัดครั้งละ 100 application ต่อแต่ละ stage เพื่อลดความเสี่ยงจาก run ขนาดใหญ่
- ลบ R2 ก่อน D1; ถ้า R2 ล้มเหลว D1 จะยังมี key ให้ retry ได้
- D1 update/delete ทำซ้ำได้และ cascade child rows ตาม foreign keys
- Log เฉพาะ event name และจำนวน ไม่ log application id หรือข้อมูลส่วนบุคคล

## Legal or investigation hold

เมื่อมีข้อพิพาท การตรวจสอบ หรือคำสั่งที่ชอบด้วยกฎหมาย ผู้ดูแลอาจกำหนด `retention_hold_until` เป็นเวลา UTC ในอนาคต Cron จะข้าม record นั้นทุก stage การตั้งและยกเลิก hold ต้องมี Issue แบบ private/จำกัดสิทธิ์ที่บันทึกเหตุผลโดยไม่แนบ PII และต้องมีผู้ดูแลอนุมัติ วิธีดำเนินการอยู่ใน [operations runbook](operations-runbook.md#retention-and-erasure)

## Verification

Tests ต้องครอบคลุม abandoned deletion, paid in-progress exclusion, 90-day PII erasure, active hold, seven-year final deletion, R2 deletion, cascades และ idempotent rerun Automated tests ใช้ข้อมูลสังเคราะห์และ Miniflare เท่านั้น
