# VRA Membership Registration System

ระบบรับสมัครสมาชิกออนไลน์ของสมาคมนักวิทยุอาสาสมัคร (VRA) บน Cloudflare โดยเน้นค่าใช้จ่ายต่ำ การดูแลรักษาน้อย และการคุ้มครองข้อมูลส่วนบุคคลตั้งแต่ต้นทาง

โครงการยังอยู่ในระยะ bootstrap ข้อกำหนดผลิตภัณฑ์ฉบับหลักอยู่ที่ [Issue #1](https://github.com/awatchar/vra-membership/issues/1) และงานทุกชิ้นต้องเริ่มจาก Issue ขนาดเล็กที่เชื่อมกลับไปยัง Issue ดังกล่าว

## Architecture target

- Cloudflare Workers สำหรับ API และ static frontend
- Cloudflare D1 สำหรับข้อมูลใบสมัครและ audit events
- Private Cloudflare R2 สำหรับรูปสมาชิกที่ผู้สมัครเลือกเท่านั้น
- Cloudflare Turnstile และ Access สำหรับ abuse protection และ admin authentication
- iApp, SlipOK และ Resend ผ่าน provider abstractions ฝั่ง server

ภาพบัตรประชาชนทั้งใบและรูปสลิปต้องไม่ถูก persist และห้ามนำ PII หรือ secrets เข้า GitHub, logs, Issue หรือ PR

## Development workflow

1. อ่าน [AGENTS.md](AGENTS.md) และ [CONTRIBUTING.md](CONTRIBUTING.md)
2. สร้างหรือรับผิดชอบ Issue ที่มี scope และ acceptance criteria ชัดเจน
3. ทำงานบน branch/worktree แยกจาก `main`
4. เปิด Draft PR ตั้งแต่ต้น เชื่อม Issue และอัปเดตผลทดสอบอย่างต่อเนื่อง
5. ให้ CI ผ่านและรับ human review สำหรับงาน security, privacy, migration และ deployment
6. ใช้ squash merge และลบ branch หลัง merge

ตรวจ baseline ของ repository ในเครื่องด้วย:

```powershell
pwsh -NoLogo -NoProfile -File ./scripts/validate-repository.ps1
```

คำสั่ง install, lint, typecheck, test และ build จะเพิ่มพร้อม application scaffold และ lockfile ใน PR แยก ห้ามเดาคำสั่งที่ยังไม่มีใน manifest

## Documentation

- [การพัฒนา](docs/development.md)
- [สถาปัตยกรรม](docs/architecture.md)
- [Security และ Privacy](docs/security-privacy.md)
- [การ deploy](docs/deployment.md)
- [การประสานงานหลาย AI](docs/ai-collaboration.md)

## Security

อ่าน [SECURITY.md](SECURITY.md) ก่อนรายงานช่องโหว่ ห้ามแนบข้อมูลจริงของสมาชิก ภาพบัตรประชาชน สลิป หรือ API keys ในช่องทาง GitHub
