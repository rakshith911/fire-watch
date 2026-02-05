// Generate a unique build ID for each DMG build
// This forces models to re-download on every new DMG installation

const fs = require("fs");
const path = require("path");

const buildId = `build-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const outputPath = path.join(__dirname, "../electron/build-id.txt");

fs.writeFileSync(outputPath, buildId);

console.log(`✅ Generated build ID: ${buildId}`);
console.log(`   Written to: ${outputPath}`);
