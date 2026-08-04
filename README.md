# Multi-Website Scraper System v3.0.0 — Public Site Migration Edition

## โหมดสำรวจและย้ายข้อมูลสาธารณะทั้งเว็บไซต์

เวอร์ชันนี้เพิ่ม Full Public-Site Migration สำหรับเว็บไซต์ อบต. เทศบาล และหน่วยงานรัฐ:

- สำรวจหน้าในโดเมนเดียวกันจาก DOM ที่ JavaScript render แล้วและ `sitemap.xml`
- เก็บ HTML, ข้อความ, PDF, Office, Archive, รูป, วิดีโอ, เสียง, CSS, JavaScript และ Font
- รองรับ URL ดาวน์โหลดที่ไม่มีนามสกุลด้วย Content-Type / Content-Disposition / Magic Bytes
- เก็บ CDN เฉพาะทรัพยากรที่หน้าเว็บโหลดจริง
- Resume ด้วย checkpoint และลบไฟล์ซ้ำด้วย SHA-256
- Cloudflare ใช้ Chrome session ที่ผู้ใช้ผ่านหน้าตรวจสอบด้วยตนเอง ไม่เจาะ CAPTCHA หรือหลังบ้าน

คู่มือเต็ม: `PUBLIC_SITE_MIGRATION_V3_README.txt`



## ตรวจบริษัทผู้พัฒนาและเลือก Adapter อัตโนมัติ

กรอก `เว็บไซต์หลักสำหรับตรวจบริษัท` แล้วระบบจะตรวจลายนิ้วมือจาก Footer, iframe,
โดเมนทรัพยากร, Script/CSS และรูปแบบ URL ก่อนเลือกโปรแกรมดึงข้อมูลเฉพาะค่าย:

- `cjworld` — CJ World Communication
- `pasworld` — PASWorld Communication
- `dungbhumi` — บริษัท ดังภูมิ คอร์ปอเรชั่น จำกัด
- `generic` — Adaptive Parser สำหรับเว็บไซต์ที่ไม่ตรงกับค่ายที่รู้จัก

ปุ่ม `เริ่มดึงข้อมูล` จะตรวจ Vendor และเลือก Adapter ซ้ำให้อัตโนมัติ จึงสามารถ
กรอกเว็บไซต์หลักแล้วเริ่มงานได้ทันที ส่วนปุ่ม `ตรวจบริษัทและค้นหาหมวด` ใช้สำหรับ
ดูผลล่วงหน้าและเติม URL หมวดมาตรฐานลงแบบฟอร์ม

ผลการตรวจถูกบันทึกที่:

- MySQL table `site_vendor_profile`
- `downloads/scrape_<site>/vendor-detection.json`

ดูรายละเอียดการเพิ่มบริษัทใหม่ที่ `VENDOR_ADAPTER_SYSTEM_README.txt`

ระบบดึงข้อมูลผ่านหน้าเว็บ UI โดยทำงาน 3 ส่วนตามลำดับ:

1. จัดซื้อจัดจ้าง
2. ประชาสัมพันธ์
3. ภาพกิจกรรม
4. หัวข้อเพิ่มเติมได้หลายหมวดและหลาย path

ระบบรองรับข้อความรายละเอียด รูปภาพ วิดีโอ เสียง ไฟล์เอกสาร และลิงก์วิดีโอแบบ embed
พร้อมสร้าง `รายละเอียดกิจกรรม.txt` แยกต่อกิจกรรม

และหน่วงเวลา 2 นาทีระหว่างแต่ละส่วน พร้อมบันทึกลงฐานข้อมูล MySQL และแจ้งเตือน LINE เมื่อเสร็จ

หน้า UI จะมีช่อง `ชื่อเว็บไซต์` เมื่อกรอกชื่อแล้วระบบจะสร้างฐานข้อมูลใหม่ตามชื่อนั้นอัตโนมัติ

## โครงสร้างฐานข้อมูล (สร้างใหม่ต่อเว็บไซต์)

- Database: `scrape_<website_name>` เช่น `scrape_nongtalay`
- Tables:
  - `procurement_files`
  - `public_relations_files`
  - `activity_pictures_file`
  - `activity_details`
  - `activity_media_files`
  - `file_download_audit`
  - `site_vendor_profile`

ตารางข่าวหลักและตารางหัวข้อเพิ่มเติมมีคอลัมน์ `detail_text`, `published_at`,
`media_type`, `embed_url`, `file_sha256`, `pdf_data` และ `pdf_stored_in_db`

## ติดตั้งและรัน

```bash
npm install
```

คัดลอกไฟล์ env:

```bash
copy .env.example .env
```

แก้ค่าใน `.env` ให้ตรงกับเครื่อง (MySQL/Port/User/Password)

เริ่มระบบ:

```bash
npm start
```

เปิดใช้งานที่:

- [http://localhost:3000](http://localhost:3000)

## หมายเหตุ LINE Notify

- ระบบใช้ LINE Notify API (`notify-api.line.me`) โดยต้องใส่ token ของกลุ่ม
- ถ้าไม่ใส่ token ระบบจะข้ามขั้นตอนแจ้งเตือนอัตโนมัติ

## หมายเหตุการรองรับหลายเว็บไซต์

- ระบบนี้รองรับการแยกงานและแยกฐานข้อมูลต่อเว็บไซต์จากข้อมูลที่กรอกใน UI
- Parser ใช้ Adaptive Route Detection รองรับ `cat_id`, `cid`, `news_id`, parameter ชื่ออื่นที่เป็นรหัส, path แบบ PHP/HTML และ path แบบใหม่
- รองรับหน้าเริ่มต้นคนละชื่อ เช่น `procedure.php`, `statement.php`, `plan_3.php`, `rank.php` และ route อื่นใน directory เดียวกัน
- เว็บไซต์ที่ต้อง Login, CAPTCHA หรือใช้ API เฉพาะทางอาจต้องเพิ่ม Adapter เฉพาะเว็บไซต์

## File audit report

เวอร์ชันนี้ตรวจสอบลิงก์ไฟล์แนบทุกไฟล์ระหว่างการทำงาน พร้อมแยกสถานะดาวน์โหลดสำเร็จ, HTTP 404, HTTP 403, timeout, network error, HTML ที่ไม่ใช่ไฟล์ และลิงก์ต่างโดเมนที่ถูกข้าม

ดูผลได้จากหน้าเว็บในส่วน **ตรวจสอบไฟล์แนบ** และดาวน์โหลด CSV/JSON ได้ทันที รายงานถาวรถูกเก็บใน `downloads/<database>/reports/` และข้อมูลละเอียดถูกบันทึกในตาราง MySQL `file_download_audit`

อ่านรายละเอียดเพิ่มเติมที่ `FILE_AUDIT_README.txt`


## รองรับวิดีโอและ PDF ในฐานข้อมูล

- วิดีโอไฟล์ตรง เช่น MP4/WebM/MOV จะดาวน์โหลดลงโฟลเดอร์และเก็บ metadata ใน `activity_media_files` หรือ table ข่าวนั้น
- YouTube/Vimeo/Facebook/TikTok เก็บ `media_provider` และ `embed_url`
- PDF เก็บไฟล์ในโฟลเดอร์ และเก็บ binary ใน `pdf_data LONGBLOB` เมื่อเปิด `STORE_PDF_IN_DB=true`
- คู่มือการตั้งค่าดินอุดมอยู่ใน `DINUDOM_GENERIC_PATH_VIDEO_README.txt`
