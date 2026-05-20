// Run: node --experimental-vm-modules scripts/benchmark_vjepa.js
// Starts the V-JEPA sidecar, runs S and B benchmarks, prints a comparison table.

import { startSidecar, runBenchmark, stopSidecar } from "../src/services/vjepaSidecar.js";

console.log("\n🔬 V-JEPA S vs B Benchmark\n");
console.log("Models will be downloaded from HuggingFace on first run (~350MB each).");
console.log("This may take a few minutes...\n");

startSidecar();

try {
  const result = await runBenchmark();

  if (!result.ok) {
    console.error("Benchmark failed:", result.error);
    process.exit(1);
  }

  const { benchmark } = result;

  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│           V-JEPA Model Comparison (on-prem)             │");
  console.log("├──────────┬───────────┬───────────┬──────────┬───────────┤");
  console.log("│  Model   │  HF ID    │ RAM (MB)  │ Avg (ms) │ Min (ms)  │");
  console.log("├──────────┼───────────┼───────────┼──────────┼───────────┤");

  for (const [size, r] of Object.entries(benchmark)) {
    const id = (r.model_id || "custom-ViT").replace("MCG-NJU/", "");
    console.log(
      `│  ViT-${size}   │ ${id.padEnd(9)} │ ${String(r.ram_delta_mb).padStart(8)} │` +
      ` ${String(r.inference_ms_avg).padStart(7)}  │ ${String(r.inference_ms_min).padStart(8)} │`
    );
  }

  console.log("└──────────┴───────────┴───────────┴──────────┴───────────┘");
  console.log(`\nDevice: ${benchmark.S?.device}`);

  const sAvg = benchmark.S?.inference_ms_avg;
  const bAvg = benchmark.B?.inference_ms_avg;
  if (sAvg && bAvg) {
    const ratio = (bAvg / sAvg).toFixed(1);
    console.log(`\nViT-B is ${ratio}x slower than ViT-S on this machine.`);
    console.log(
      bAvg < 3000
        ? "✅ Both models are fast enough for real-time use (< 3s per clip)."
        : sAvg < 3000
        ? "⚠️  Only ViT-S is fast enough. Use S on this machine, B on servers."
        : "❌ Both are slow on this machine — consider EC2 for inference."
    );
  }
} catch (e) {
  console.error("Error:", e.message);
} finally {
  stopSidecar();
  process.exit(0);
}
