import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// AGPL §13: 配信中の版と対応するソースを対応付けるため、ビルドへコミットハッシュを刻む。
// cwd でなくこのファイルの場所を基準にする (別リポジトリから起動された dev サーバーが
// 隣のリポジトリのハッシュを拾う事故の防止)。
function buildCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8", cwd: fileURLToPath(new URL(".", import.meta.url)) }).trim();
  } catch {
    return "unknown";
  }
}

function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  server: {
    host: "127.0.0.1",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
