// 轻量校验：manifest 合法性 + workflow 结构性检查（不依赖 yaml 库）
const fs = require("fs");
const path = require("path");

const repo = path.join(__dirname, "..");
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? "\n       " + detail : ""}`);
  }
};

/* ---------- manifest ---------- */
console.log("[manifest]");
const manifest = JSON.parse(fs.readFileSync(path.join(repo, "manifest.json"), "utf8"));
check("manifest_version = 3", manifest.manifest_version === 3);
check(
  "version 符合 Chrome 规则",
  /^[0-9]+(\.[0-9]+){0,3}$/.test(manifest.version),
  manifest.version
);
check("声明了 options_ui", !!manifest.options_ui && !!manifest.options_ui.page);
check("action 有 default_icon", !!manifest.action.default_icon);
check("permissions 含 storage", manifest.permissions.includes("storage"));

for (const file of [manifest.background.service_worker, manifest.options_ui.page]) {
  check(`入口文件存在：${file}`, fs.existsSync(path.join(repo, file)));
}
for (const size of [16, 32, 48, 128]) {
  check(`图标存在：${size}`, fs.existsSync(path.join(repo, `icons/icon${size}.png`)));
}

/* ---------- workflow ---------- */
console.log("\n[build.yml]");
const yml = fs.readFileSync(path.join(repo, ".github/workflows/build.yml"), "utf8");
const lines = yml.split(/\r?\n/);

// 缩进只能是 2 的倍数（YAML 结构性粗检）
// 注意：`run: |` 块内的内容属于 shell 脚本，缩进是正文的一部分，不参与结构校验
let badIndent = [];
let blockIndent = null;
lines.forEach((line, i) => {
  if (!line.trim()) return;
  const indent = line.length - line.trimStart().length;

  if (blockIndent !== null) {
    if (indent > blockIndent) return; // 块标量正文，跳过
    blockIndent = null; // 块结束
  }
  if (line.trim().startsWith("#")) return;
  if (indent % 2 !== 0) badIndent.push(`L${i + 1}: ${line.trim()}`);

  if (/:\s*[|>][-+]?\s*$/.test(line.trimEnd())) blockIndent = indent;
});
check("缩进均为 2 的倍数", badIndent.length === 0, badIndent.join("\n       "));
check("成功识别出 run 块", blockIndent === null && lines.some(l => /:\s*\|/.test(l)));

check("用 manifest.json 作为版本源", /jq -r '\.version' manifest\.json/.test(yml));
check(
  "不再用 git tag 推算版本（旧 bug）",
  !/tag --list/.test(yml)
);
// 只要点一下 Run workflow 就跑完，不再有下拉选项需要选
check("没有 bump 之类的必填选项", !/inputs\.bump/.test(yml) && !/^\s+bump:/m.test(yml));
check("没有 dry_run 之类的开关", !/dry_run/.test(yml));
check("版本号自动 +1", /PATCH \+ 1/.test(yml));
check("有版本号强校验", /version 非法/.test(yml));
check("有打包后完整性校验", /压缩包缺少/.test(yml));
check("声明了 contents: write 权限", /contents:\s*write/.test(yml));
check("加了 concurrency 防并发发版", /concurrency:/.test(yml));
check("README 以「使用说明.md」入包", /使用说明\.md/.test(yml));
// 检查 zip 段没有被误写成非法的 --name 用法
check("没有非法的 zip --name 用法", !/zip .*--name/.test(yml), "zip 不支持 --name 重命名");
// tab 会破坏 YAML
check("没有制表符", !/\t/.test(yml));

/* ---------- 打包内容模拟 ---------- */
console.log("\n[打包清单]");
const excludeMatch = yml.match(/zip -r "\$ARCHIVE" \. \\\n([\s\S]*?)\n\n/);
check("能解析 zip 排除段", !!excludeMatch);
if (excludeMatch) {
  const excludes = excludeMatch[1];
  check("排除 test/*（测试不进包）", /test\/\*/.test(excludes));
  check("保留 icons", !/icons/.test(excludes.split("-x")[1] || ""));
}

/* ---------- 旧版兼容 ---------- */
console.log("\n[README]");
const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
check("README 提到设置页", /选项|设置/.test(readme));

console.log("\n" + (failures ? `❌ ${failures} 项失败` : "✅ 全部通过"));
process.exit(failures ? 1 : 0);
