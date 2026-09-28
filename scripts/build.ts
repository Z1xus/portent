import { rm } from "node:fs/promises";

const entries = {
  start: "src/main.ts",
  check: "src/cli/check.ts",
  simulate: "src/cli/simulate.ts",
  preflight: "src/cli/preflight.ts",
  "auth:derive": "src/cli/auth-derive.ts",
} as const;

await rm("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: Object.values(entries),
  root: "src",
  outdir: "dist",
  target: "bun",
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const scripts = Object.fromEntries(
  Object.entries(entries).map(([name, entry]) => [name, `bun ${entry.replace(/^src\//u, "").replace(/\.ts$/u, ".js")}`]),
);
await Bun.write("dist/package.json", `${JSON.stringify({ name: "portent", private: true, type: "module", scripts }, null, 2)}\n`);
console.log(`Built ${result.outputs.length} bundles in dist/`);
