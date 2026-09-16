/* =====================================================================
   build.mjs — 把 client/index.js 及其依赖打成 DSH 客户端插件产物
   =====================================================================
   产物 lib/client.js 必须形如：

     window.__ModuleLoader__.load({
       id: "<包名>",
       factory: (require) => { var module = {exports:{}}; ... return module.exports }
     });

   因此用 esbuild 以 CJS 格式打包（react 等平台基线模块保持 external，
   运行时由 factory 的 require 解析），再用 banner/footer 套上外壳。
   ===================================================================== */
import { build, context } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  await (await import("node:fs/promises")).readFile(path.join(root, "package.json"), "utf8")
);
const PLUGIN_ID = pkg.name;

/** 平台基线模块：由 shell 的静态模块表提供，不能打进产物。 */
const BASELINE = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis"
];

const options = {
  entryPoints: [path.join(root, "client/index.js")],
  outfile: path.join(root, "lib/client.js"),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
  sourcemap: true,
  external: BASELINE,
  /* CSS 以文本导入，运行时用 <style> 注入（DSH 客户端插件没有单独的 CSS 通道）。 */
  loader: { ".css": "text" },
  banner: {
    js: [
      `/* ${PLUGIN_ID} v${pkg.version} — 由 build.mjs 生成，请勿手改；改 client/ 与 assets/ 后重新构建。 */`,
      "window.__ModuleLoader__.load({",
      `\tid: ${JSON.stringify(PLUGIN_ID)},`,
      "\tfactory: (require) => {",
      "\t\tvar module = { exports: {} };",
      "\t\tvar exports = module.exports;",
      '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });'
    ].join("\n")
  },
  footer: {
    js: ["\t\treturn module.exports;", "\t}", "});"].join("\n")
  },
  logLevel: "info"
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`[${PLUGIN_ID}] watching…`);
} else {
  await build(options);
  console.log(`[${PLUGIN_ID}] built -> lib/client.js`);
}
