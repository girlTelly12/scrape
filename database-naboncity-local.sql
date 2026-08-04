-- ใช้ใน phpMyAdmin/XAMPP เมื่อต้องการสร้างฐานชื่อเดียวกับระบบเดิม
-- ไม่สร้าง user และไม่ฝังรหัสผ่าน
CREATE DATABASE IF NOT EXISTS `nabonct_cjworld`
  DEFAULT CHARACTER SET tis620
  COLLATE tis620_thai_ci;

ALTER DATABASE `nabonct_cjworld`
  DEFAULT CHARACTER SET tis620
  COLLATE tis620_thai_ci;
