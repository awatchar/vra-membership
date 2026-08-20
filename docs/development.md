# Development

## Toolchain

| Item             | Value                                                                              |
| ---------------- | ---------------------------------------------------------------------------------- |
| Runtime          | Node.js, version pinned in [`.nvmrc`](../.nvmrc)                                   |
| Package manager  | npm (lockfile `package-lock.json` is committed)                                    |
| Worker framework | [Hono](https://hono.dev) on Cloudflare Workers                                     |
| Client           | React + Vite, built to `dist/client` and served through the Workers assets binding |
| Validation       | zod                                                                                |
| Tests            | Vitest running inside workerd via `@cloudflare/vitest-pool-workers`                |
| Lint / format    | ESLint (flat config, type-aware) and Prettier                                      |

เหตุผลของการเลือกเทคโนโลยีอยู่ใน [decision record 0001](decisions/0001-application-stack.md)

## Install

```bash
npm ci
```

`npm ci` ใช้ `package-lock.json` เท่านั้น จึงได้ผลเหมือนกันทั้งในเครื่องและใน CI

หมายเหตุ: npm ตั้งแต่รุ่นที่ต้องอนุมัติ install script จะอ่านรายการที่อนุญาตจากฟิลด์ `allowScripts` ใน `package.json` ซึ่งอนุญาตเฉพาะ `esbuild` และ `workerd` ที่ต้องดาวน์โหลด binary ของตัวเอง

## Quality commands

คำสั่งเหล่านี้เป็น source of truth และ CI รันชุดเดียวกัน

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run check:worker:production
```

เพิ่มเติม

```bash
npm run lint:fix        # แก้ปัญหา lint ที่แก้อัตโนมัติได้
npm run format          # จัดรูปแบบไฟล์
npm run test:watch      # รัน test แบบ watch
npm run cf-typegen      # สร้าง worker-configuration.d.ts ใหม่หลังแก้ wrangler.jsonc
```

`npm run typecheck` ใช้ TypeScript project references สามชุด: `tsconfig.worker.json` (Worker + tests), `tsconfig.web.json` (client) และ `tsconfig.tools.json` (build config)

## Run locally

ใช้สอง terminal

```bash
# 1) Worker API + bindings (D1/R2 แบบ local) ที่ http://127.0.0.1:8787
npm run dev:api

# 2) Client แบบ hot reload ที่ http://localhost:5173 โดย proxy /api ไปยัง Worker
npm run dev:web
```

ถ้าต้องการทดสอบ production shape (Worker เสิร์ฟ static assets เอง) ให้รัน `npm run build:web` แล้ว `npm run dev:api` และเปิด http://127.0.0.1:8787

## Local secrets

1. คัดลอก [`.env.example`](../.env.example) เป็น `.dev.vars` (ถูก ignore ใน Git)
2. ใส่ค่าทดสอบเท่านั้น ห้ามใส่ production key
3. ไฟล์ credential ภายใต้ `api/` ห้ามเข้า Git และห้ามส่งต่อให้ agent อื่น (ทั้งโฟลเดอร์ถูก ignore)

`PROVIDER_MODE` ควบคุมว่า Worker จะใช้ provider จริงหรือ mock ค่าเริ่มต้นของ development และ test คือ `mock`

## Providers and tests

External providers อยู่หลัง interface ใน `src/worker/providers/types.ts` และมี mock ใน `src/worker/providers/mock/`

Automated tests ห้ามยิง iApp, SlipOK หรือ Resend จริง `vitest.config.ts` บังคับ `PROVIDER_MODE=mock` และ factory จะ throw เมื่อขอ live adapter ที่ยังไม่มี

Test fixtures ต้องเป็นข้อมูลสังเคราะห์ที่ย้อนกลับไปหาบุคคลจริงไม่ได้

## Logging

Worker ต้อง log ผ่าน `src/worker/lib/logger.ts` เท่านั้น logger ใช้ allowlist ของ field ทางเทคนิค และตัด field อื่นทั้งหมดทิ้ง ESLint บล็อก `console` ใน `src/worker/**` เพื่อกันการ log PII โดยไม่ตั้งใจ

## Repository baseline

รันก่อน commit และก่อนเปิด PR

```powershell
pwsh -NoLogo -NoProfile -File ./scripts/validate-repository.ps1
```

บน Windows ที่มีเฉพาะ Windows PowerShell ใช้ `powershell -NoLogo -NoProfile -File .\scripts\validate-repository.ps1` ได้เช่นกัน
