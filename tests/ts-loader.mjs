// 测试用 ESM 加载器：
// 1) 为无扩展名的相对 import 补 .ts（TS 源码按 Vite 风格省略扩展名）；
// 2) 用 esbuild 即时转译 .ts（应用本身由 Vite 构建，不依赖它）。
import { transform } from "esbuild";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/.test(specifier)) {
    const parentUrl = context.parentURL ?? pathToFileURL(process.cwd() + "/").href;
    const base = new URL(specifier, parentUrl);
    const basePath = fileURLToPath(base);
    for (const candidate of [`${basePath}.ts`, `${basePath}/index.ts`]) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts")) {
    const raw = await nextLoad(url, { ...context, format: "module" }).catch(() => null);
    const source =
      raw?.source ??
      (await import("node:fs/promises").then((fs) => fs.readFile(new URL(url), "utf8")));
    const result = await transform(String(source), {
      loader: "ts",
      format: "esm",
      target: "es2020",
      sourcemap: "inline",
    });
    return { format: "module", source: result.code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
