# 0001: Application stack and delivery pipeline

- Status: accepted
- Date: 2026-08-20
- Issue: #3

## Context

Issue #1 กำหนดว่าระบบต้องอยู่บน Cloudflare Workers, D1, private R2, Turnstile และ Cloudflare Access โดยมีปริมาณงานประมาณ 1-2 ใบสมัครต่อวัน ต้องค่าใช้จ่ายต่ำ maintenance ต่ำ และไม่เพิ่ม infrastructure เกินจำเป็น

Repository อยู่ในระยะ bootstrap และยังไม่มี manifest, lockfile, test runner หรือ deployment pipeline จึงยังไม่มีคำสั่ง install/lint/typecheck/test/build ที่เชื่อถือได้

ข้อจำกัดเพิ่มเติมจาก AGENTS.md คือ automated tests ห้ามยิง provider จริง, secrets ต้องอยู่ฝั่ง server, และ logs ห้ามมี PII

## Decision

1. **Package manager: npm** พร้อม commit `package-lock.json` และ pin Node.js ผ่าน `.nvmrc` npm มาพร้อม Node จึงไม่ต้องติดตั้ง toolchain เพิ่มทั้งในเครื่องและใน CI ฟิลด์ `allowScripts` อนุญาต install script เฉพาะ `esbuild` และ `workerd` ที่ต้องดาวน์โหลด binary
2. **Worker framework: Hono** เพราะเล็ก ออกแบบมาสำหรับ Workers และไม่ต้องมี build step ของตัวเอง ทำให้ routing, middleware และ error handling เป็นระเบียบโดยไม่เพิ่ม runtime dependency มาก
3. **Client: React + Vite** build ลง `dist/client` แล้วให้ Workers assets binding เสิร์ฟ ขั้นตอนสมัครสมาชิกเป็น wizard หลายขั้นที่มีการถ่ายภาพ crop รูป และ decode QR ฝั่ง browser ซึ่งต้องการ state management ที่ตรวจสอบได้ การเขียนด้วย DOM API ตรง ๆ จะกลายเป็น state machine ที่ทำเองและ test ยากกว่า
4. **Validation: zod** ใช้ทั้งกับ configuration และ request payload เพื่อให้ validation เป็น schema เดียวที่อ่านออก
5. **Tests: Vitest ผ่าน `@cloudflare/vitest-pool-workers`** ทุก suite รันใน workerd จริงและเข้าถึง D1/R2 binding ได้ ทำให้ test schema, storage และ routing ได้โดยไม่ต้องมี integration environment แยก และ `PROVIDER_MODE=mock` ถูกบังคับใน test config
6. **Provider abstraction** iApp, SlipOK และ Resend อยู่หลัง interface ใน `src/worker/providers/types.ts` พร้อม mock ใน `src/worker/providers/mock/` factory จะ throw `ProviderNotConfiguredError` เมื่อขอ live adapter ที่ยังไม่มี แทนที่จะ fallback ไปใช้ mock เงียบ ๆ บน production
7. **Logging** ผ่าน allowlist logger เท่านั้น และ ESLint บล็อก `console` ใน `src/worker/**`
8. **Delivery** แยก quality gates เป็น reusable workflow ที่ทั้ง `ci.yml` และ `deploy.yml` เรียกใช้ job deploy มี `needs` ผูกกับ gates และผูกกับ GitHub environment `production` การเปิด delivery จริงคุมด้วย repository variable `CLOUDFLARE_DEPLOY_ENABLED`

## Consequences

- Install, lint, typecheck, test และ build ทำซ้ำได้จาก clean checkout ด้วย `npm ci` และ script ใน manifest
- CI ไม่ต้องใช้ production secret และไม่เรียก provider จริง
- Production deploy ใช้ gates ชุดเดียวกับ CI ทำให้ไม่มีทางลัด
- ยัง deploy production ไม่ได้จนกว่าผู้ดูแลบัญชี Cloudflare จะสร้าง D1, R2, custom domain, secrets, GitHub environment และเปิด `CLOUDFLARE_DEPLOY_ENABLED` ขั้นตอนอยู่ใน `docs/deployment.md`
- การใช้ React เพิ่ม dependency ฝั่ง client ต้องคุม bundle size ต่อไปและใช้ Dependabot group เพื่อลด PR churn
- Vitest workers pool ต้องใช้ `wrangler.jsonc` เป็น source ของ binding ทำให้การแก้ config กระทบ test ด้วย ซึ่งเป็นผลที่ต้องการเพราะจับ config ที่ผิดได้เร็ว

## Alternatives considered

- **pnpm/yarn** เร็วกว่าในบางกรณีแต่ต้องติดตั้งเพิ่มทั้งในเครื่องและ CI โดยไม่ได้ประโยชน์ที่ชัดเจนกับ repository ขนาดนี้
- **Worker เขียนด้วย `fetch` handler ล้วน ไม่ใช้ framework** ลด dependency ได้หนึ่งตัวแต่ต้องเขียน routing, error mapping และ middleware เอง ซึ่งเป็นจุดที่ผิดพลาดได้ง่ายในส่วน security
- **Full-stack framework (Remix/Next/SvelteKit) บน Workers** ให้ SSR และ routing สำเร็จรูป แต่เพิ่ม build complexity, cold start และ maintenance เกินความจำเป็นสำหรับ 1-2 ใบสมัครต่อวัน
- **Vanilla TypeScript ฝั่ง client** ลด dependency แต่ทำให้ wizard หลายขั้นตอนกลายเป็น state machine ที่เขียนเองและ test ยาก
- **`@cloudflare/vite-plugin` รวม build ของ Worker กับ client** สะดวกขึ้นแต่ผูก build ของ Worker เข้ากับ Vite major version การให้ Wrangler bundle Worker และ Vite bundle client แยกกันลด coupling
- **Deploy ด้วย `workflow_run` หลัง CI สำเร็จ** ทำได้แต่ต้อง resolve commit SHA เองและอ่านยากกว่า การเรียก reusable workflow แล้วใช้ `needs` ให้ผลเหมือนกันโดยชัดเจนกว่า
- **ปล่อยให้ deploy ล้มเหลวจนกว่าจะตั้งค่า Cloudflare เสร็จ** ตรงไปตรงมาแต่ทำให้ `main` เป็นสีแดงตลอด repository variable ทำให้สถานะ "ยังไม่เปิด delivery" ชัดเจนและตรวจสอบได้
