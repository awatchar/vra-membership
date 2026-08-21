# 0003: Store the selected full member-photo frame

- Status: accepted
- Date: 2026-08-21
- Issue: #52

## Context

ข้อกำหนดเดิมใน #1 แนะนำให้ผู้สมัคร crop รูปสมาชิกเป็น 3:4 ก่อนส่ง และ Worker ปฏิเสธสัดส่วนอื่น เจ้าของระบบทดสอบ flow จริงแล้วตัดสินใจเอา crop UI ออกจากทั้งทางเลือกภาพใบหน้าจาก iApp และภาพที่อัปโหลดเอง เพื่อไม่ให้ผู้สมัครต้องจัดกรอบซ้ำและเพื่อให้สมาคมได้รับภาพเต็มที่ผู้สมัครเลือก

การลบเฉพาะ UI ไม่พอ เพราะ Worker ยังบังคับ 3:4 และจะปฏิเสธรูปเต็ม สัญญาของ browser, API และ stored object จึงต้องเปลี่ยนพร้อมกัน โดยรูปสมาชิกเป็นภาพส่วนบุคคลชนิดเดียวที่ระบบ persist การเปลี่ยนนี้ต้องรักษาการยินยอม ขอบเขตขนาด metadata removal และ private storage เดิมทั้งหมด

## Decision

- Preview และส่งภาพที่เลือกทั้งเฟรม ไม่มี drag, zoom, crop region หรือ canvas crop
- ภาพอัปโหลดที่ใหญ่ถูกย่อตามสัดส่วนและ re-encode เป็น JPEG; ไม่มี pixel ที่ขอบภาพถูกตัด
- ภาพ JPEG ที่เล็กพออาจส่งโดยไม่ encode ซ้ำ แต่ Worker strip EXIF, XMP, IPTC และ metadata segment ก่อนเก็บ
- Worker ยอมรับสัดส่วนแนวตั้ง จัตุรัส และแนวนอนภายในขอบเขตความละเอียดและขนาดไฟล์เดิม ไม่บังคับ aspect ratio
- Storage ยังรับ JPEG เท่านั้น เพราะ Worker ยังไม่มี metadata-safe rewrite สำหรับ PNG/WebP
- ภาพจาก iApp ยังเป็นเฉพาะ field `face` ที่ provider crop จากบัตร ไม่ใช่ภาพบัตรทั้งใบ และต้องมี explicit consent ก่อนเก็บ
- `POST /api/member-photo` ยังคง Turnstile, rate limit, magic-byte validation, private R2 และ random object key ทุกข้อ

## Consequences

- สมาคมได้รับข้อมูลภาพมากกว่ารูป 3:4 ที่ crop แล้ว แต่ยังเป็นเฉพาะรูปที่ผู้สมัครเห็นใน preview และยืนยันว่าจะใช้ทำบัตร
- ขั้นตอนพิมพ์บัตรต้องกำหนดวิธี fit ภาพตามสัดส่วนจริงภายหลัง ห้ามถือว่า stored object เป็น 3:4
- ไฟล์จากกล้องที่เล็กกว่าเพดานอาจออกจาก browser พร้อม metadata ชั่วคราว แต่ Worker ลบก่อน persist; รูปใหญ่ถูกลบ metadata ตั้งแต่ canvas re-encode ใน browser
- Automated tests ต้องครอบแนวตั้ง จัตุรัส และแนวนอน และต้องยืนยันว่าไม่มี crop control หรือ crop transform กลับมา

## Alternatives considered

- **คง crop 3:4** — ทำให้ขั้นตอนสมัครซับซ้อนและขัดกับการตัดสินใจจาก owner QA
- **ลบ UI แต่คง Worker 3:4** — ผู้สมัครจะผ่าน preview แล้วถูก API ปฏิเสธ จึงเป็นสัญญาที่ขัดกัน
- **เก็บไฟล์ต้นฉบับทุกชนิดโดยไม่ re-encode/strip** — รักษา bytes ได้มากที่สุดแต่เก็บ EXIF/GPS และ metadata ที่ไม่มีวัตถุประสงค์ทางธุรกิจ
- **เพิ่ม image decoder/WASM ใน Worker เพื่อ normalize ทุกชนิด** — เพิ่ม bundle, CPU และ maintenance เกินประโยชน์สำหรับ 1–2 ใบสมัครต่อวัน
