/*
 * Template สำหรับเพิ่มบริษัทผู้พัฒนาเว็บไซต์รายใหม่
 * 1) คัดลอกไฟล์นี้เป็นชื่อบริษัท เช่น mycompany.js
 * 2) แก้ id/name และ RegExp ให้ตรงกับโครงสร้างของบริษัท
 * 3) เพิ่ม require และลงทะเบียนใน src/vendors/registry.js
 * 4) เพิ่มลายนิ้วมือใน src/vendors/definitions.js
 */
const { createAdapter } = require("./base");

module.exports = createAdapter({
    id: "mycompany",
    name: "My Company",
    profile: {
        news: {
            detailUrlPatterns: [/\/news\/detail\//i],
            listingUrlPatterns: [/\/news\//i],
            preferredDetailIdParams: ["id"],
        },
        activity: {
            detailUrlPatterns: [/\/gallery\/detail\//i],
            listingUrlPatterns: [/\/gallery\/?$/i],
            preferredActivityIdParams: ["id"],
        },
    },
});
