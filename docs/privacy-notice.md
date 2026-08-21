# Privacy notice review copy

ฉบับ production แสดงที่ `https://member.vra.or.th/privacy` และ render จาก [`src/web/privacy/PrivacyNotice.tsx`](../src/web/privacy/PrivacyNotice.tsx) ข้อความด้านล่างเป็น review record ที่ผู้ดูแลต้องเทียบกับหน้าจริงก่อน go-live

## ผู้ควบคุมข้อมูลและช่องทางติดต่อ

สมาคมนักวิทยุอาสาสมัครเป็นผู้ควบคุมข้อมูลส่วนบุคคล ติดต่อผู้จัดการสมาคมที่ `turakanvra@gmail.com`, โทร. 098 832 2522 หรือ ตู้ ปณ.1 ปณฝ.บางแค กรุงเทพมหานคร 10161 ข้อมูลติดต่ออ้างจาก [เว็บไซต์สมาคม](https://vra.or.th/)

## เนื้อหาที่ต้องมีในหน้าจริง

- ประเภทข้อมูลและวัตถุประสงค์: ใบสมัคร, duplicate check, NBTC processing, member card, payment/receipt, notifications และ security audit
- สิ่งที่ไม่เก็บ: full ID-card image, slip image, raw provider response, bounding boxes และข้อมูลที่ไม่จำเป็น
- ฐานการประมวลผลและ explicit selection เมื่อใช้ภาพใบหน้าจากบัตรเป็นรูปสมาชิก
- ผู้ให้บริการ Cloudflare, iApp, SlipOK, Resend, ผู้จัดการสมาคม และสำนักงาน กสทช.
- ความเป็นไปได้ของ cross-border processing และการใช้มาตรการคุ้มครองที่เหมาะสม
- retention 30 วัน / PII 90 วัน / accounting record ไม่เกิน 7 ปี
- สิทธิของเจ้าของข้อมูล ช่องทางใช้สิทธิ การถอนความยินยอม และสิทธิร้องเรียน
- ผลหากไม่ให้ข้อมูลที่จำเป็น
- มาตรการ Cloudflare Access, encryption, private R2, anti-bot/rate limiting และ no-PII logging

## Human sign-off

- [ ] ผู้มีอำนาจของสมาคมยืนยันชื่อผู้ควบคุมข้อมูลและช่องทางติดต่อ
- [ ] ผู้มีอำนาจยืนยันวัตถุประสงค์ ผู้รับข้อมูล และ retention schedule
- [ ] ตรวจหน้า `/privacy` บนมือถือและ desktop ว่าตรงกับ review copy
- [ ] ตรวจว่า checkbox หน้าแรกเป็น acknowledgement และไม่ถูกติ๊กไว้ล่วงหน้า
- [ ] ตรวจว่าการเลือกใช้ภาพใบหน้าจากบัตรเกิดในขั้นรูปสมาชิกอย่างชัดเจน

ผู้อนุมัติและวันที่ให้บันทึกใน Issue #19 โดยไม่ใส่ข้อมูลส่วนบุคคลที่ไม่เป็นสาธารณะ
