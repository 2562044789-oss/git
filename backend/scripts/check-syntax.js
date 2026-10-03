// 语法检查：覆盖 backend/src 下全部 .js 文件（含 routes/ 子目录）。
// 之前的 npm run check 硬编码了 8 个文件，架构重构后新增的 12 个 routes 文件
// 一直没被覆盖 —— 改成自动收集，以后加文件不再需要同步维护这份清单。
// 用 vm.Script 做编译级语法检查（不执行代码、不拉子进程）。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "src");

function collectJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectJsFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

const files = collectJsFiles(root);
const failures = [];

for (const file of files) {
  try {
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: file });
  } catch (error) {
    failures.push({ file, message: String(error) });
  }
}

console.log(`语法检查：${files.length - failures.length}/${files.length} 个文件通过`);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[FAIL] ${path.relative(root, failure.file)}`);
    console.error(failure.message);
  }
  process.exit(1);
}
