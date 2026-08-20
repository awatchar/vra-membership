# Contributing

งานใน repository นี้ใช้กระบวนการ Issue → branch/worktree → Draft PR → CI → review → squash merge เป็นหลัก ทั้งมนุษย์และ AI agents ต้องปฏิบัติตาม [AGENTS.md](AGENTS.md)

## 1. Prepare the Issue

- ใช้ Issue #1 เป็น product epic และแตกงานเป็น Issue ที่จบได้ใน PR เดียว
- ระบุ scope, non-goals, acceptance criteria, dependencies, security/privacy impact และ test plan
- ประกาศผู้รับผิดชอบและ path ที่จะเปลี่ยนก่อนเริ่ม เพื่อป้องกันหลาย agent แก้ไฟล์เดียวกัน
- ถ้าพบ blocker หรือเปลี่ยนทิศทาง ให้อัปเดต Issue ก่อนเขียนโค้ดต่อ

## 2. Create isolated work

อัปเดต `main` แล้วสร้าง branch/worktree แยก:

```text
feat/issue-12-payment-state-machine
fix/issue-34-webhook-signature
docs/issue-8-privacy-notice
chore/issue-2-ai-collaboration-foundation
```

ห้าม push โดยตรงเข้า `main` และห้ามแชร์ worktree เดียวกันระหว่าง agents ที่แก้ไขพร้อมกัน

## 3. Implement and verify

- เปลี่ยนเฉพาะไฟล์ใน scope และรักษาการแก้ไขของผู้อื่น
- ใช้ provider mocks ใน automated tests; ห้ามยิง iApp, SlipOK หรือ Resend จริง
- ห้ามใช้ production secrets ใน local development หรือ CI
- รัน repository baseline และคำสั่งที่กำหนดใน manifest/README
- ถ้าข้ามการทดสอบใด ต้องบอกเหตุผลและความเสี่ยงใน PR

## 4. Open a Draft PR

- เปิด Draft PR ตั้งแต่เริ่มมีโครงสร้างที่ review ได้
- ใช้ PR template ให้ครบและเชื่อม Issue ด้วย `Closes #N` หรือ `Refs #N`
- ใส่ภาพหน้าจอเฉพาะข้อมูลจำลอง ห้ามมี PII หรือข้อมูล production
- อัปเดต PR เดิมแทนการเปิด PR ซ้ำสำหรับ branch เดียวกัน

## 5. Review and merge

- CI ต้องผ่านก่อน merge
- งาน security, privacy, payment, schema migration และ deployment ต้องมี human review
- ใช้ squash merge เพื่อให้หนึ่ง Issue มี commit หลักที่ชัดเจน
- ลบ branch หลัง merge และปิด Issue เมื่อ acceptance criteria ผ่านจริง

Repository plan ปัจจุบันอาจไม่รองรับการบังคับ branch protection สำหรับ private repository จึงต้องถือกติกานี้เป็น mandatory แม้ GitHub UI ยังบังคับไม่ได้
