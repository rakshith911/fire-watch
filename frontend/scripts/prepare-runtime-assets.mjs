#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MEDIA_MTX_VERSION = "1.15.6";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(scriptDirectory, "..");
const runtimeDirectory = path.join(frontendDirectory, "build", "runtime");
const extractionDirectory = path.join(runtimeDirectory, "extract");

function assetDetails() {
  const architecture = process.arch === "x64" ? "amd64" : process.arch;

  if (process.platform === "darwin") {
    return {
      archive: `mediamtx_v${MEDIA_MTX_VERSION}_darwin_${architecture}.tar.gz`,
      binary: "mediamtx",
    };
  }

  if (process.platform === "win32") {
    return {
      archive: `mediamtx_v${MEDIA_MTX_VERSION}_windows_${architecture}.zip`,
      binary: "mediamtx.exe",
    };
  }

  if (process.platform === "linux") {
    return {
      archive: `mediamtx_v${MEDIA_MTX_VERSION}_linux_${architecture}.tar.gz`,
      binary: "mediamtx",
    };
  }

  throw new Error(`Unsupported build platform: ${process.platform}/${process.arch}`);
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

const { archive, binary } = assetDetails();
const archivePath = path.join(runtimeDirectory, archive);
const sourceUrl = `https://github.com/bluenviron/mediamtx/releases/download/v${MEDIA_MTX_VERSION}/${archive}`;

await fs.rm(runtimeDirectory, { recursive: true, force: true });
await fs.mkdir(extractionDirectory, { recursive: true });

console.log(`Downloading MediaMTX ${MEDIA_MTX_VERSION} for ${process.platform}/${process.arch}...`);
await download(sourceUrl, archivePath);

execFileSync("tar", ["-xf", archivePath, "-C", extractionDirectory], {
  stdio: "inherit",
});

const extractedBinary = path.join(extractionDirectory, binary);
const targetBinary = path.join(runtimeDirectory, binary);
await fs.copyFile(extractedBinary, targetBinary);
if (process.platform !== "win32") await fs.chmod(targetBinary, 0o755);

await fs.rm(extractionDirectory, { recursive: true, force: true });
await fs.rm(archivePath, { force: true });

console.log(`Runtime asset ready: ${targetBinary}`);
