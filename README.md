# VRA Membership Registration System

ระบบรับสมัครสมาชิกออนไลน์ของสมาคมนักวิทยุอาสาสมัคร (VRA) บน Cloudflare โดยเน้นค่าใช้จ่ายต่ำ การดูแลรักษาน้อย และการคุ้มครองข้อมูลส่วนบุคคลตั้งแต่ต้นทาง

ข้อกำหนดผลิตภัณฑ์ฉบับหลักอยู่ที่ [Issue #1](https://github.com/awatchar/vra-membership/issues/1) และงานทุกชิ้นต้องเริ่มจาก Issue ขนาดเล็กที่เชื่อมกลับไปยัง Issue ดังกล่าว

## Architecture

- Cloudflare Workers สำหรับ API และ static frontend
- Cloudflare D1 สำหรับข้อมูลใบสมัครและ audit events
- Private Cloudflare R2 สำหรับรูปสมาชิกที่ผู้สมัครเลือกเท่านั้น
- Cloudflare Turnstile และ Access สำหรับ abuse protection และ admin authentication
- iApp, SlipOK และ Resend ผ่าน provider abstractions ฝั่ง server

ภาพบัตรประชาชนทั้งใบและรูปสลิปต้องไม่ถูก persist และห้ามนำ PII หรือ secrets เข้า GitHub, logs, Issue หรือ PR

## Stack

Node.js (ตาม [`.nvmrc`](.nvmrc)) + npm, Hono บน Cloudflare Workers, React + Vite ฝั่ง client, zod สำหรับ validation, Vitest ที่รันใน workerd ผ่าน `@cloudflare/vitest-pool-workers`, ESLint + Prettier

เหตุผลของการเลือกอยู่ใน [decision record 0001](docs/decisions/0001-application-stack.md)

## Quick start

```bash
npm ci
cp .env.example .dev.vars   # ใส่ค่าทดสอบเท่านั้น ห้ามใส่ production key
npm run dev:api             # Worker API ที่ http://127.0.0.1:8787
npm run dev:web             # Client ที่ http://localhost:5173 (proxy /api ไปยัง Worker)
```

ตรวจสอบว่าใช้งานได้: `curl http://127.0.0.1:8787/api/health`

## Commands

| คำสั่ง                            | หน้าที่                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `npm ci`                          | ติดตั้ง dependency จาก lockfile                                |
| `npm run lint`                    | ESLint แบบ type-aware                                          |
| `npm run format:check`            | ตรวจรูปแบบด้วย Prettier                                        |
| `npm run typecheck`               | TypeScript project references ทั้งสามชุด                       |
| `npm test`                        | Vitest ใน workerd (provider เป็น mock เท่านั้น)                |
| `npm run build`                   | build client (`dist/client`) และ worker bundle                 |
| `npm run check:worker:production` | dry-run ของ production wrangler configuration                  |
| `npm run cf-typegen`              | สร้าง `worker-configuration.d.ts` ใหม่หลังแก้ `wrangler.jsonc` |

CI รันชุดเดียวกันนี้ รายละเอียดใน [docs/development.md](docs/development.md)

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

## Documentation

- [การพัฒนา](docs/development.md)
- [สถาปัตยกรรม](docs/architecture.md)
- [Security และ Privacy](docs/security-privacy.md)
- [การ deploy](docs/deployment.md)
- [การประสานงานหลาย AI](docs/ai-collaboration.md)
- [Decision records](docs/decisions/README.md)
- [D1 migrations](migrations/README.md)

## Security

อ่าน [SECURITY.md](SECURITY.md) ก่อนรายงานช่องโหว่ ห้ามแนบข้อมูลจริงของสมาชิก ภาพบัตรประชาชน สลิป หรือ API keys ในช่องทาง GitHub
