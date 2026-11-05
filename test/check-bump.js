// 校验 workflow 中 bump 选项的中文文案与实际 shell case 分支的对应关系
// 无法在本机跑 bash（沙箱限制），因此用等价逻辑模拟：
// - 从 yml 里解析 options / default / case 分支
// - 按 bash case 的 glob 规则（前缀 * / 精确 / 空值）匹配
// - 验证每个 UI 选项都命中正确分支，且非法输入会报错
const fs = require("fs");
const path = require("path");

const repo = path.join(__dirname, "..");
const yml = fs.readFileSync(path.join(repo, ".github/workflows/build.yml"), "utf8");

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? "\n       " + detail : ""}`);
  }
};

/* ---------- 解析 options ---------- */
const optBlock = yml.match(/\n\s+options:\n((?:\s+- .*\r?\n)+)/);
check("能解析 bump 的 options", !!optBlock);
const options = optBlock
  ? optBlock[1]
      .split(/\r?\n/)
      .map(l => l.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean)
  : [];

console.log("  选项:", JSON.stringify(options));
check("共 3 个选项", options.length === 3);
check(
  "不再出现裸的 patch/minor/major",
  options.every(o => !/^(patch|minor|major)$/i.test(o))
);
check(
  "每个选项都带中文说明",
  options.every(o => /[\u4e00-\u9fff]/.test(o))
);

/* ---------- 解析 default ---------- */
const dfltMatch = yml.match(/\n\s+default:\s*(.+?)\r?$/m);
const dflt = dfltMatch ? dfltMatch[1].trim() : null;
check("default 是其中一个中文选项", !!dflt && options.includes(dflt), String(dflt));

/* ---------- 解析 case 分支 ---------- */
const caseBlock = yml.match(/case "\$BUMP" in\r?\n([\s\S]*?)\r?\n\s*esac/);
check("能解析 case 分支", !!caseBlock);

const branches = [];
if (caseBlock) {
  const lines = caseBlock[1].replace(/\r\n/g, "\n").split("\n");
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (!cur) {
      // 分支头：pattern) [...同行动作]
      const m = line.match(/^([^)]+)\)\s*(.*)$/);
      if (!m) continue;
      const patterns = m[1].split("|").map(s => s.trim());
      if (!patterns.every(Boolean)) continue;
      cur = { patterns, action: m[2] || "" };
    } else {
      cur.action += " " + line;
    }

    // 用 ;; 结束当前分支
    if (cur && cur.action.includes(";;")) {
      cur.action = cur.action.split(";;")[0].trim();
      branches.push(cur);
      const after = line.split(";;").slice(1).join(";;").trim();
      cur = after ? { patterns: [], action: after } : null;
      if (cur && !cur.action.endsWith(";;")) { /* 续行 */ }
      if (cur && cur.action.includes(";;")) {
        cur.action = cur.action.split(";;")[0].trim();
        branches.push(cur);
        cur = null;
      }
    }
  }
  if (cur) {
    cur.action = cur.action.replace(/;;$/, "").trim();
    branches.push(cur);
  }
}
check(
  "解析出 4 个分支（含兜底）",
  branches.length === 4,
  `得到 ${branches.length}: ${JSON.stringify(branches.map(b => b.patterns))}`
);

/* ---------- 按 bash case 语义匹配 ---------- */
function matchBranch(bump) {
  for (const b of branches) {
    for (const p of b.patterns) {
      if (p === '""') {
        if (bump === "") return b;
        continue;
      }
      if (p.endsWith("*")) {
        if (bump.startsWith(p.slice(0, -1))) return b;
        continue;
      }
      if (p === bump) return b;
    }
  }
  return null;
}

function bumpOf(bump, current) {
  const parts = current.split(".").map(Number);
  while (parts.length < 3) parts.push(0);
  const [major, minor, patch] = parts;
  const b = matchBranch(bump);
  if (!b) return null;
  if (b.action.includes("exit 1")) return null; // 兜底报错分支
  if (b.action.includes("MAJOR + 1")) return `${major + 1}.0.0`;
  if (b.action.includes("MINOR + 1")) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

console.log("\n[递增行为 @2.2.0]");
const cases = [
  ["修订补丁（只修 bug）", "2.2.1"],
  ["功能更新（加新功能）", "2.3.0"],
  ["重大版本（不兼容改动）", "3.0.0"],
  ["patch", "2.2.1"],
  ["minor", "2.3.0"],
  ["major", "3.0.0"],
  ["", "2.2.1"]
];
for (const [input, want] of cases) {
  const got = bumpOf(input, "2.2.0");
  check(`"${input || "(空)"}" => ${want}`, got === want, `得到 ${got}`);
}

console.log("\n[UI 选项可达性]");
for (const opt of options) {
  const got = bumpOf(opt, "2.2.0");
  check(`「${opt}」能正确递增`, !!got && got !== "2.2.0", `得到 ${got}（未命中或落入报错兜底）`);
}

console.log("\n[防御]");
check("非法取值会报错而非静默递增", bumpOf("随便乱填", "2.2.0") === null);
check("兜底分支不会静默算补丁", !branches.some(b => b.patterns.length === 1 && b.patterns[0] === "*" && !b.action.includes("exit 1")));

// 不同当前版本下的递增
console.log("\n[其它起点]");
check("2.9.9 补丁 => 2.9.10", bumpOf("修订补丁（只修 bug）", "2.9.9") === "2.9.10");
check("2.9.9 功能 => 2.10.0", bumpOf("功能更新（加新功能）", "2.9.9") === "2.10.0");
check("2.9.9 重大 => 3.0.0", bumpOf("重大版本（不兼容改动）", "2.9.9") === "3.0.0");
check("不完整版本 2 => 2.0.1", bumpOf("修订补丁（只修 bug）", "2") === "2.0.1");

console.log("\n" + (failures ? `❌ ${failures} 项失败` : "✅ 全部通过"));
process.exit(failures ? 1 : 0);
