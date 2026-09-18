import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(frontendDir, "dist");
const port = Number(process.env.PORT || 4173);

if (!fs.existsSync(distDir)) {
  throw new Error("frontend/dist is missing. Run: node frontend/build.mjs");
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

http
  .createServer((request, response) => {
    const requestPath = request.url?.split("?")[0] || "/";
    const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const candidate = path.resolve(distDir, relativePath);
    const filePath = candidate.startsWith(distDir) && fs.existsSync(candidate)
      ? candidate
      : path.join(distDir, "index.html");
    const extension = path.extname(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(fs.readFileSync(filePath));
  })
  .listen(port, () => {
    console.log(`StockSplit frontend running at http://localhost:${port}`);
  });
