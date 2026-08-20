// LiteRT-LM の WASM 実体をローカル配信するため node_modules から public/ へコピーする。
// public/litertlm-wasm/ は .gitignore 対象 (4種類の .js + .wasm で合計 100MB 超のためリポジトリに入れない)。
// 実行: corepack pnpm wasm:copy
//
// これを配置しておかないと loadLiteRtLm() を呼ばないコードパスでは
// https://cdn.jsdelivr.net/npm/@litert-lm/core@0.15.0/wasm から CDN 取得される
// (LiteRtLm.DEFAULT_WASM_PATH)。オンデバイス検証では CDN 非依存を確かめたいので、
// spike/local-gemma.ts は明示的に loadLiteRtLm('/litertlm-wasm/') を呼ぶ。
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const srcDir = path.join(here, "..", "node_modules", "@litert-lm", "core", "wasm");
const destDir = path.join(here, "..", "public", "litertlm-wasm");

if (!existsSync(srcDir)) {
  console.error(`[wasm:copy] コピー元が見つかりません: ${srcDir}`);
  console.error("[wasm:copy] 先に `corepack pnpm install` で @litert-lm/core を入れてください。");
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

const files = readdirSync(srcDir).filter((name) => statSync(path.join(srcDir, name)).isFile());

let copied = 0;
let skipped = 0;
for (const name of files) {
  const srcPath = path.join(srcDir, name);
  const destPath = path.join(destDir, name);
  const srcStat = statSync(srcPath);

  if (existsSync(destPath)) {
    const destStat = statSync(destPath);
    // サイズと更新日時が両方一致していれば同一内容とみなして再コピーを省く。
    if (destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) {
      skipped++;
      continue;
    }
  }

  copyFileSync(srcPath, destPath);
  copied++;
}

const totalBytes = files.reduce((sum, name) => sum + statSync(path.join(srcDir, name)).size, 0);
console.log(
  `[wasm:copy] ${srcDir} -> ${destDir}\n` +
    `[wasm:copy] コピー ${copied} 件 / スキップ ${skipped} 件 / 合計 ${files.length} ファイル (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`,
);
