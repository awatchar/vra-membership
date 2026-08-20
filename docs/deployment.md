# Deployment

เป้าหมาย production คือ Cloudflare Workers ที่ `member.vra.or.th` พร้อม D1, private R2, Turnstile และ Cloudflare Access

การสร้าง application scaffold และเปิด delivery pipeline ติดตามใน [Issue #3](https://github.com/awatchar/vra-membership/issues/3)

## CD activation gate

ยังไม่เปิด deployment workflow จนกว่า PR ของ application scaffold จะมีครบ:

- committed package manifest และ lockfile
- `wrangler` configuration แยก development/production โดยไม่มี secret values
- D1 migrations และขั้นตอน rollback/forward-fix
- test/build commands ที่ผ่านใน CI
- GitHub `production` environment และ Cloudflare token ที่จำกัดสิทธิ์เท่าที่จำเป็น
- mapping ของ D1/R2/Turnstile/Access ที่ตรวจโดยผู้ดูแล
- smoke test ที่ไม่ใช้ PII และไม่เรียก provider production โดยไม่จำเป็น

เมื่อผ่าน gate ให้เพิ่ม CD workflow ผ่าน Issue/PR แยก โดย deploy เฉพาะ commit บน `main` ที่ CI ผ่าน ใช้ environment protection และบันทึก deployment URL/commit SHA ห้าม deploy จาก PR ของ fork หรือ expose secrets ให้ PR workflows

รายละเอียด deployment และ rollback จริงต้องอัปเดตในเอกสารนี้ก่อน production launch
