// Use the project's existing TypeScript compiler; no extra test dependency.
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import ts from "../dashboard/node_modules/typescript/lib/typescript.js";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith(".ts")) return next(url, context);
    return { format: "module", shortCircuit: true, source: ts.transpileModule(
      readFileSync(new URL(url), "utf8"), { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      } }).outputText };
  },
});
