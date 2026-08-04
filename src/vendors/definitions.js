const CJWORLD_OTHER_TOPICS = [
    { title: "ข้อบัญญัติงบประมาณรายจ่าย", path: "/datacenter/statement.php" },
    { title: "แผนพัฒนาท้องถิ่น", path: "/datacenter/plan_3.php" },
    { title: "แผนอัตรากำลัง", path: "/datacenter/rank.php" },
    { title: "รายงานติดตามประเมินผลแผนพัฒนาท้องถิ่น", path: "/datacenter/plan_y.php" },
    { title: "ระเบียบและข้อกฎหมาย ต่างๆ", path: "/datacenter/rule.php" },
    { title: "งานบริหารงานบุคคล", path: "/datacenter/borihan.php" },
    { title: "งบแสดงฐานะทางการเงิน", path: "/datacenter/finance.php" },
    { title: "วารสารประชาสัมพันธ์", path: "/datacenter/plan_m.php" },
    { title: "แบบฟอร์มและคำร้องต่างๆของสำนักปลัด งานพัฒนาชุมชน", path: "/datacenter/plan_t0.php" },
    { title: "ขั้นตอน/ระยะเวลาการให้บริการ", path: "/datacenter/result.php" },
];

const VENDOR_DEFINITIONS = [
    {
        id: "cjworld",
        name: "CJ World Communication",
        aliases: ["CJ World", "ซีเจ เวิลด์", "CJWORLD"],
        textPatterns: [
            { re: /cj\s*world\s*communication/i, weight: 120, label: "พบชื่อ CJ World Communication" },
            { re: /ซี\.?\s*เจ\.?\s*เวิลด์/i, weight: 110, label: "พบชื่อบริษัทซีเจเวิลด์" },
            { re: /cjworld\.co\.th/i, weight: 130, label: "พบโดเมน cjworld.co.th" },
        ],
        urlPatterns: [
            { re: /(?:^|\.)cjworld\.co\.th$/i, weight: 150, label: "โหลดทรัพยากรจาก cjworld.co.th" },
            { re: /\/introall\/intro-[^/?]+\.php/i, weight: 110, label: "พบหน้า intro ของ CJ World" },
            { re: /\/datacenter\/(?:procedure|procedure1|information|statement|plan(?:_[a-z0-9]+)?|rank|rule|borihan|finance|result)\.php/i, weight: 35, label: "พบโครงสร้าง /datacenter แบบ CJ World" },
            { re: /\/album\/(?:index|view)\.php/i, weight: 35, label: "พบโครงสร้าง /album แบบ CJ World" },
        ],
        defaultSections: {
            procurementUrl: "/datacenter/procedure.php",
            publicRelationsUrl: "/datacenter/information.php",
            activityUrl: "/album/index.php",
            otherTopics: CJWORLD_OTHER_TOPICS,
        },
    },
    {
        id: "pasworld",
        name: "PASWorld Communication",
        aliases: ["PASWorld", "พาสเวิลด์"],
        textPatterns: [
            { re: /pas\s*world\s*communication/i, weight: 140, label: "พบชื่อ PASWorld Communication" },
            { re: /pasworld/i, weight: 90, label: "พบคำว่า PASWorld" },
            { re: /พาส\s*เวิลด์/i, weight: 100, label: "พบชื่อพาสเวิลด์" },
        ],
        urlPatterns: [
            { re: /(?:^|\.)pasworld[^.]*\.(?:com|co\.th)$/i, weight: 150, label: "พบโดเมน PASWorld" },
            { re: /\/news\.php\?[^#]*\bcat_id=/i, weight: 28, label: "พบ news.php?cat_id แบบ PASWorld" },
            { re: /\/(?:albums?|photo)\/(?:index|view)\.php/i, weight: 25, label: "พบโครงสร้างอัลบั้มแบบ PASWorld" },
        ],
        defaultSections: {
            procurementUrl: "/news.php?cat_id=13",
            publicRelationsUrl: "/news.php?cat_id=1",
            activityUrl: "/albums/index.php",
            otherTopics: [],
        },
    },
    {
        id: "dungbhumi",
        name: "Dungbhumi Corporation",
        aliases: ["ดังภูมิ คอร์ปอเรชั่น", "Dungbhumi"],
        textPatterns: [
            { re: /บริษัท\s*ดังภูมิ\s*คอร์ปอเรชั่น/i, weight: 150, label: "พบชื่อบริษัท ดังภูมิ คอร์ปอเรชั่น" },
            { re: /dungbhumi/i, weight: 120, label: "พบคำว่า dungbhumi" },
            { re: /staff@dungbhumi\.com/i, weight: 150, label: "พบอีเมลผู้ดูแล dungbhumi.com" },
        ],
        urlPatterns: [
            { re: /(?:^|\.)dungbhumi\.com$/i, weight: 160, label: "พบโดเมน dungbhumi.com" },
            { re: /\/public\/(?:list|rss)\/data\//i, weight: 70, label: "พบโครงสร้าง /public/list|rss/data แบบ Dungbhumi" },
            { re: /\/public\/default\/index/i, weight: 45, label: "พบหน้า default/index แบบ Dungbhumi" },
        ],
        defaultSections: {
            procurementUrl: "",
            publicRelationsUrl: "",
            activityUrl: "",
            otherTopics: [],
        },
    },
];

module.exports = {
    CJWORLD_OTHER_TOPICS,
    VENDOR_DEFINITIONS,
};
