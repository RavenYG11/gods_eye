import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

test("backend serves health, rejects removed dataset API and preserves existing data", { timeout: 20000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gods-eye-api-"));
  const database = path.join(directory, "dataset.db");
  writeFileSync(database, "existing user data must not be touched");
  const child = spawn(process.execPath, ["--no-warnings", "backend/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATASET_DB_PATH: path.join(directory, "dataset.db") },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  child.stderr.on("data", (data) => { output += data; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Backend startup timeout: ${output}`)), 10000);
      child.stdout.on("data", (data) => {
        output += data;
        const match = output.match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
    });
    const get = (route, init) => fetch(`http://127.0.0.1:${port}${route}`, init);
    const health = await get("/api/health");
    assert.equal((await health.json()).ok, true);
    assert.equal(health.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal((await get("/api/missing")).status, 404);
    assert.equal((await get("/models/missing.onnx")).status, 404);
    for (const route of ["/api/dataset", "/api/dataset/export", "/api/dataset/1/image"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await get(route, { method });
        assert.equal(response.status, 404);
        assert.equal((await response.json()).ok, false);
      }
    }
    assert.equal(readFileSync(database, "utf8"), "existing user data must not be touched");
  } finally {
    const exited = once(child, "exit");
    if (child.exitCode === null) { child.kill(); await exited; }
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(directory).startsWith("gods-eye-api-"));
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
