#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(scriptDirectory, "..", "dist-electron");
const forbiddenKeys = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "COGNITO_CLIENT_SECRET",
]);

async function findEnvironmentFiles(directory, results = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await findEnvironmentFiles(entryPath, results);
    } else if (entry.name === ".env") {
      results.push(entryPath);
    }
  }
  return results;
}

const environmentFiles = await findEnvironmentFiles(outputDirectory);
if (environmentFiles.length === 0) {
  throw new Error("No packaged backend .env file was found");
}

for (const environmentFile of environmentFiles) {
  const keys = (await fs.readFile(environmentFile, "utf8"))
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf("=")));
  const leakedKeys = keys.filter((key) => forbiddenKeys.has(key));
  if (leakedKeys.length > 0) {
    throw new Error(
      `Forbidden credential keys in ${environmentFile}: ${leakedKeys.join(", ")}`
    );
  }
}

console.log(`PUBLIC_PACKAGE_CHECK_OK (${environmentFiles.length} environment file(s))`);
