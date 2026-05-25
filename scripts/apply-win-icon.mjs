import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rcedit } from "rcedit";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exePath = path.join(projectRoot, "release", "win-unpacked", "QDex.exe");
const iconPath = path.join(projectRoot, "build", "icon.ico");

await Promise.all([
  assertFile(exePath),
  assertFile(iconPath)
]);

await rcedit(exePath, { icon: iconPath });

console.log(`Applied Windows executable icon: ${path.relative(projectRoot, iconPath)}`);

async function assertFile(filePath) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Expected a file at ${filePath}`);
  }
}
