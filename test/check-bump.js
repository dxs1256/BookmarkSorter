// 验证 build.yml 里 bump 选项的中文文案与 bash case 分支匹配
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

// 取出 options 列表
const optBlock = yml.match(/\n\s+options:\n((?:\s+- .*\n)+)/);
check("能解析 bump 的 options", !!optBlock);
const options = optBlock
  ? optBlock[1]
      .split("\n")
      .map(l => l.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean)
  : [];

console.log("  选项:", JSON.stringify(options, null, 0));
check("共 3 个选项", options.length === 3);
check(
  "全部为中文（不含裸 patch/minor/major）",
  options.every(o => !/^(patch|minor|major)$/i.test(o))
);

// 取出 default
const dflt = yml.match(/\n\s+default:\s*(.+?)\s*$/m);
check("default 是中文选项之一", !!dflt && options.includes(dflt[1]), dflt && dflt[1]);

// 取出 case 分支里的中文关键字
const caseBlock = yml.match(/case "\$BUMP" in\r?\n([\s\S]*?)\r?\n\s*esac/);
check("能解析 case 分支", !!caseBlock);

function bumpOf(bump, current) {
  const parts = current.split(".").map(Number);
  while (parts.length < 3) parts.push(0);
  let [major, minor, patch] = parts;
  let matched = null;
  for (const line of caseBlock[1].split(/\r?\n/)) {
    const m = line.match(/^\s*([^)]+)\)\s*(.*)$/);
    if (!m) continue;
    const patterns = m[1].split("|").map(s => s.trim());
    const hit = patterns.some(p => {
      if (p === '""') return bump === "";
      if (p.endsWith("*")) return bump.startsWith(p.slice(0, -1));
      return p === bump;
    });
    if (hit) {
      matched = m[2];
      break;
    }
  }
  if (!matched) return null;
  if (matched.includes("MAJOR + 1")) return `${major + 1}.0.0`;
  if (matched.includes("MINOR + 1")) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

console.log("\n[递增行为]");
const cur = "2.2.0";
const expect = new Map([
  ["修订补丁（只修 bug）", "2.2.1"],
  ["功能更新（加新功能）", "2.3.0"],
  ["重大版本（不兼容改动）", "3.0.0"],
  ["patch", "2.2.1"],
  ["minor", "2.3.0"],
  ["major", "3.0.0"],
  ["", "2.2.1"]
]);

for (const [input, want] of expect) {
  const got = bumpOf(input, cur);
  check(`"${input || "(空)"}" => ${want}`, got === want, `得到 ${got}`);
}

// 每个 UI 选项都必须命中某个分支，且不能落进兜底的报错
console.log("\n[UI 选项可达性]");
for (const opt of options) {
  const got = bumpOf(opt, cur);
  check(`选项「${opt}」能正确递增`, !!got, "未命中任何分支（会走报错）");
}

// 非法输入必须报错，而不是静默当补丁
check("非法输入被拒绝", bumpOf("随便乱填", cur) === null);

console.log("\n" + (failures ? `❌ ${failures} 项失败` : "✅ 全部通过"));
process.exit(failures ? 1 : 0);
