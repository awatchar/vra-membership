# Multi-AI Collaboration

GitHub เป็น coordination plane หลัก: Issue เก็บ scope/ownership/decisions, branch แยก work, PR เก็บ diff/review/CI และ comment เก็บ handoff ชั่วคราว

## One agent, one scoped Issue, one worktree

- แตก epic เป็นงานที่ review และ rollback ได้อิสระ
- agent ประกาศ Issue, branch และ path ownership ก่อนแก้ไฟล์
- งานที่พึ่งกันใช้ linked Issues และระบุ dependency; อย่าแก้ไฟล์เดียวกันพร้อมกัน
- ถ้าจำเป็นต้องเปลี่ยน scope ให้ตกลงใน Issue ก่อน

## Handoff format

โพสต์ใน Issue หรือ PR ด้วยหัวข้อต่อไปนี้:

```text
Completed:
Remaining:
Changed paths:
Verification commands and results:
Risks / assumptions:
Next safe action:
```

อย่าสร้างไฟล์ status ชั่วคราวหลายชุดใน repository เพราะจะเกิด merge conflict และข้อมูลล้าสมัย เอกสารถาวรเท่านั้นที่ควรอยู่ใน `docs/`

## Conflict protocol

เมื่อพบการแก้ไขของผู้อื่น ให้หยุดเฉพาะ path ที่ชนกัน แจ้งใน Issue/PR และปรับงานให้เข้ากับการเปลี่ยนแปลงล่าสุด ห้าม reset/revert งานที่ไม่ได้เป็นเจ้าของ การรวม branch ที่มี conflict หรือ security-sensitive changes ต้องให้มนุษย์ตรวจ
