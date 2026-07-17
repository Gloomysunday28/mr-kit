// 打前端更新包：把 index.html + styles.css + main.js 内联成单个自包含 HTML，
// 并生成带 sha256 的清单。产物挂在滚动 Release `webui` 上，客户端定期拉取。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const outDir = join(root, "dist-webui");

const indexHtml = readFileSync(join(srcDir, "index.html"), "utf8");
const styles = readFileSync(join(srcDir, "styles.css"), "utf8");
const mainJs = readFileSync(join(srcDir, "main.js"), "utf8");
const diff2htmlCss = readFileSync(join(srcDir, "vendor/diff2html.min.css"), "utf8");
const diff2htmlJs = readFileSync(join(srcDir, "vendor/diff2html.min.js"), "utf8");
const compat = JSON.parse(readFileSync(join(srcDir, "webui-compat.json"), "utf8"));

// 内联后这些 token 会提前终结 <script>/<style>，必须挡住
if (/<\/script/i.test(mainJs) || /<!--/.test(mainJs)) {
  throw new Error("main.js 含有 </script> 或 <!--，无法安全内联，请改写后重试");
}
if (/<\/script/i.test(diff2htmlJs) || /<!--/.test(diff2htmlJs)) {
  throw new Error("diff2html.min.js 含有 </script> 或 <!--，无法安全内联");
}
if (/<\/style/i.test(styles)) {
  throw new Error("styles.css 含有 </style>，无法安全内联");
}
if (/<\/style/i.test(diff2htmlCss)) {
  throw new Error("diff2html.min.css 含有 </style>，无法安全内联");
}
if (!compat.minAppVersion) {
  throw new Error("src/webui-compat.json 缺少 minAppVersion");
}

let html = indexHtml;

// 引导块替换为内联 main.js —— 更新包里绝不能再有引导逻辑，否则会递归加载
const bootstrapRe = /[ \t]*<!-- webui-bootstrap-start[\s\S]*?<!-- webui-bootstrap-end -->/;
if (!bootstrapRe.test(html)) {
  throw new Error("index.html 里找不到 webui-bootstrap 标记块");
}
html = html.replace(bootstrapRe, () => `    <script type="module">\n${mainJs}\n</script>`);

const styleTag = '<link rel="stylesheet" href="styles.css" />';
if (!html.includes(styleTag)) {
  throw new Error(`index.html 里找不到 ${styleTag}`);
}
html = html.replace(styleTag, () => `<style>\n${styles}\n</style>`);

const diff2htmlStyleTag = '<link rel="stylesheet" href="vendor/diff2html.min.css" />';
if (!html.includes(diff2htmlStyleTag)) {
  throw new Error(`index.html 里找不到 ${diff2htmlStyleTag}`);
}
html = html.replace(diff2htmlStyleTag, () => `<style>\n${diff2htmlCss}\n</style>`);

const diff2htmlScriptTag = '<script src="vendor/diff2html.min.js"></script>';
if (!html.includes(diff2htmlScriptTag)) {
  throw new Error(`index.html 里找不到 ${diff2htmlScriptTag}`);
}
html = html.replace(diff2htmlScriptTag, () => `<script>\n${diff2htmlJs}\n</script>`);

if (/webui-bootstrap|__mrkitHotLoaded|document\.open\(\)/.test(html)) {
  throw new Error("更新包中残留引导逻辑，检查 index.html 的标记块是否完整");
}

const sha = execSync("git rev-parse --short=7 HEAD", { cwd: root }).toString().trim();
const now = new Date();
const stamp =
  now.getUTCFullYear().toString() +
  String(now.getUTCMonth() + 1).padStart(2, "0") +
  String(now.getUTCDate()).padStart(2, "0") +
  "." +
  String(now.getUTCHours()).padStart(2, "0") +
  String(now.getUTCMinutes()).padStart(2, "0");
const version = `${stamp}-${sha}`;

const sha256 = createHash("sha256").update(html, "utf8").digest("hex");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "webui.html"), html);
const manifest = {
  version,
  sha256,
  minAppVersion: compat.minAppVersion,
  ...(compat.maxAppVersion ? { maxAppVersion: compat.maxAppVersion } : {}),
};
writeFileSync(
  join(outDir, "webui.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

console.log(`webui ${version}`);
console.log(`  minAppVersion ${compat.minAppVersion}`);
if (compat.maxAppVersion) {
  console.log(`  maxAppVersion ${compat.maxAppVersion}`);
}
console.log(`  sha256 ${sha256}`);
console.log(`  ${join(outDir, "webui.html")} (${(html.length / 1024).toFixed(1)} KB)`);
