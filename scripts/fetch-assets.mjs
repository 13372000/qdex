import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const files = [
  "onnx/duration_predictor.onnx",
  "onnx/text_encoder.onnx",
  "onnx/vector_estimator.onnx",
  "onnx/vocoder.onnx",
  "onnx/tts.json",
  "onnx/unicode_indexer.json",
  "voice_styles/F1.json",
  "voice_styles/F2.json",
  "voice_styles/F3.json",
  "voice_styles/F4.json",
  "voice_styles/F5.json",
  "voice_styles/M1.json",
  "voice_styles/M2.json",
  "voice_styles/M3.json",
  "voice_styles/M4.json",
  "voice_styles/M5.json"
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

for (const file of files) {
  const destination = path.join(root, file);
  try {
    await fs.access(destination);
    console.log(`keep ${file}`);
    continue;
  } catch (_error) {
    // Download missing assets.
  }

  console.log(`download ${file}`);
  const response = await fetch(`https://huggingface.co/Supertone/supertonic-3/resolve/main/${file}?download=true`);
  if (!response.ok) {
    throw new Error(`${file}: ${response.status} ${response.statusText}`);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

console.log(`QDex assets are ready at ${root}.`);
