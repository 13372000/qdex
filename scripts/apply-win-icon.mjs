import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rcedit } from "rcedit";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exePath = path.join(projectRoot, "release", "win-unpacked", "QDex.exe");
const iconPath = path.join(projectRoot, "build", "icon.ico");
const packagePath = path.join(projectRoot, "package.json");

await Promise.all([
  assertFile(exePath),
  assertFile(iconPath),
  assertFile(packagePath)
]);

const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
const version = packageJson.version || "0.1.0";
const fileVersion = version.split(".").length >= 4 ? version : `${version}.0`;

await rcedit(exePath, {
  icon: iconPath,
  "file-version": fileVersion,
  "product-version": version,
  "version-string": {
    CompanyName: "QDex contributors",
    FileDescription: "QDex",
    InternalName: "QDex",
    LegalCopyright: "GPL-3.0-only",
    OriginalFilename: "QDex.exe",
    ProductName: "QDex"
  }
});

console.log(`Applied Windows executable resources: ${path.relative(projectRoot, exePath)}`);

async function assertFile(filePath) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Expected a file at ${filePath}`);
  }
}
