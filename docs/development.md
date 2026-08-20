# Development

## Current state

Repository ยังอยู่ในระยะ bootstrap และยังไม่มี application manifest หรือ lockfile จึงยังไม่มีคำสั่ง install/build/test ที่เชื่อถือได้ PR ที่สร้าง scaffold ต้องเลือก package manager, commit lockfile และอัปเดตเอกสารนี้กับ CI พร้อมกัน

งานดังกล่าวติดตามใน [Issue #3](https://github.com/awatchar/vra-membership/issues/3)

## Local rules

1. ใช้ข้อมูลจำลองที่ไม่ย้อนกลับไปหาบุคคลจริง
2. เก็บ local secrets ใน `.dev.vars` ซึ่งถูก ignore และใช้ชื่อ variables ตาม `.env.example`
3. ห้ามนำไฟล์ credential ภายใต้ `api/` เข้า Git หรือส่งต่อให้ agent อื่น
4. External providers ต้องอยู่หลัง interface และมี mock สำหรับ tests
5. รัน baseline ก่อน commit/PR:

```powershell
pwsh -NoLogo -NoProfile -File ./scripts/validate-repository.ps1
```

## Expected quality commands

เมื่อมี application scaffold ให้ manifest เป็น source of truth และจัดเตรียม scripts อย่างน้อยสำหรับ lint, typecheck, test และ build โดย CI ต้องใช้ dependency install แบบ locked/frozen
