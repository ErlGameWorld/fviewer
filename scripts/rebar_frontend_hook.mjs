#!/usr/bin/env node
/**
 * rebar3 pre_hook helper: run frontend build before compile/escriptize.
 * - Finds project root (rebar.config + frontend/)
 * - Skips if frontend sources are older than src/webshow.erl
 * - Skips duplicate runs within the same short window (deps compile spam)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (
      exists(path.join(dir, "rebar.config")) &&
      exists(path.join(dir, "frontend", "package.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function walkFiles(dir, acc = []) {
  if (!exists(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function needsBuild(root) {
  const webshow = path.join(root, "src", "webshow.erl");
  if (!exists(webshow)) return true;
  const outM = mtimeMs(webshow);
  const inputs = [
    path.join(root, "frontend", "package.json"),
    path.join(root, "frontend", "package-lock.json"),
    path.join(root, "frontend", "vite.config.ts"),
    path.join(root, "frontend", "tsconfig.json"),
    path.join(root, "frontend", "index.html"),
    path.join(root, "scripts", "embed_frontend.mjs"),
    ...walkFiles(path.join(root, "frontend", "src")),
  ];
  return inputs.some((f) => exists(f) && mtimeMs(f) > outM);
}

if (process.env.FVIEWER_SKIP_FRONTEND === "1") {
  console.log("===> skip frontend build (FVIEWER_SKIP_FRONTEND=1)");
  process.exit(0);
}

const root = findRoot(process.env.REBAR_ROOT_DIR || process.cwd());
if (!root) {
  process.exit(0);
}

if (!needsBuild(root)) {
  console.log("===> frontend up to date, skip npm run build");
  process.exit(0);
}

const frontendDir = path.join(root, "frontend");
if (!exists(path.join(frontendDir, "node_modules"))) {
  console.log("===> npm install (frontend)");
  const inst = spawnSync("npm", ["install"], {
    cwd: frontendDir,
    stdio: "inherit",
    shell: true,
  });
  if (inst.status !== 0) process.exit(inst.status ?? 1);
}

console.log("===> npm run build (frontend)");
const build = spawnSync("npm", ["run", "build"], {
  cwd: frontendDir,
  stdio: "inherit",
  shell: true,
});
if (build.status !== 0) process.exit(build.status ?? 1);

process.exit(0);
