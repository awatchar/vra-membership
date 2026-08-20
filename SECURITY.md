# Security Policy

## Reporting a vulnerability

อย่าเปิด public Issue สำหรับช่องโหว่หรือข้อมูลลับ ให้ใช้ [GitHub Private Vulnerability Reporting](https://github.com/awatchar/vra-membership/security/advisories/new) หรือแจ้ง repository owner ผ่านช่องทางส่วนตัวที่ตกลงกัน

รายงานควรมีผลกระทบ ขั้นตอนจำลองแบบใช้ข้อมูลปลอม และแนวทางลดความเสี่ยง ห้ามแนบ:

- API keys, tokens, private keys หรือค่าใน Cloudflare Secrets
- ข้อมูลส่วนบุคคลหรือข้อมูลใบสมัครจริง
- ภาพบัตรประชาชน รูปใบหน้า หรือรูปสลิปจริง
- raw OCR, payment-provider หรือ email-provider responses จาก production

หาก secret ถูกเปิดเผย ให้ revoke/rotate ทันที แล้วจึงตรวจประวัติ Git, CI logs, artifacts และระบบปลายทางที่อาจได้รับค่าเดิม การลบไฟล์อย่างเดียวไม่ทำให้ secret ปลอดภัยอีกครั้ง

## Supported versions

ระหว่างที่ระบบยังไม่เปิด production จะรองรับเฉพาะ revision ล่าสุดบน `main` เมื่อเริ่ม release จะกำหนดนโยบายเวอร์ชันที่นี่ก่อน deploy จริง
