import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(frontendDir, "..");
const distDir = path.join(frontendDir, "dist");
const publicFiles = new Set(["index.html", "main.js", "styles.css"]);
const visitedModules = new Set();

function includeLocalModules(relativeFile) {
  if (visitedModules.has(relativeFile)) return;
  visitedModules.add(relativeFile);
  const sourceFile = path.join(frontendDir, relativeFile);
  const source = fs.readFileSync(sourceFile, "utf8");
  for (const [, specifier] of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g)) {
    const resolved = path.resolve(path.dirname(sourceFile), specifier);
    const relative = path.relative(frontendDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.m?js$/.test(relative)) {
      throw new Error(`Unsupported local module import: ${specifier} in ${relativeFile}`);
    }
    if (!fs.existsSync(resolved)) throw new Error(`Missing local module: ${specifier} in ${relativeFile}`);
    const normalized = relative.split(path.sep).join("/");
    publicFiles.add(normalized);
    includeLocalModules(normalized);
  }
}

includeLocalModules("main.js");
publicFiles.add("stock_split_phase0.json");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const filename of publicFiles) {
  if (filename === "stock_split_phase0.json") continue;
  const destination = path.join(distDir, filename);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(frontendDir, filename), destination);
}

fs.copyFileSync(
  path.join(rootDir, "target", "idl", "stock_split_phase0.json"),
  path.join(distDir, "stock_split_phase0.json"),
);

// The combined demo server serves only these build-approved public files.
fs.writeFileSync(path.join(distDir, "asset-manifest.json"), `${JSON.stringify([...publicFiles].sort(), null, 2)}\n`);

console.log(`StockSplit frontend built ${publicFiles.size} public files to ${distDir}`);
