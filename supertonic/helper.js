import fs from "node:fs";
import path from "node:path";
import * as ort from "onnxruntime-node";

// Adapted from Supertone's official Node ONNX example helpers.
const AVAILABLE_LANGS = [
  "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi",
  "fr", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl", "pt", "ro",
  "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na"
];

class UnicodeProcessor {
  constructor(unicodeIndexerJsonPath) {
    this.indexer = JSON.parse(fs.readFileSync(unicodeIndexerJsonPath, "utf8"));
  }

  preprocessText(text, lang) {
    if (!AVAILABLE_LANGS.includes(lang)) {
      throw new Error(`Invalid language: ${lang}.`);
    }

    let normalized = text.normalize("NFKD");
    normalized = normalized.replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu,
      ""
    );
    normalized = normalized
      .replaceAll("_", " ")
      .replaceAll("[", " ")
      .replaceAll("]", " ")
      .replaceAll("|", " ")
      .replaceAll("/", " ")
      .replaceAll("#", " ")
      .replaceAll("@", " at ")
      .replace(/[\\]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!/[.!?;:,'")\]}]$/.test(normalized)) {
      normalized += ".";
    }
    return `<${lang}>${normalized}</${lang}>`;
  }

  call(textList, langList) {
    const processedTexts = textList.map((text, index) => this.preprocessText(text, langList[index]));
    const lengths = processedTexts.map((text) => text.length);
    const maxLength = Math.max(...lengths);
    const textIds = processedTexts.map((text) => {
      const row = new Array(maxLength).fill(0);
      Array.from(text).forEach((character, index) => {
        row[index] = this.indexer[character.charCodeAt(0)];
      });
      return row;
    });

    return {
      textIds,
      textMask: lengthToMask(lengths)
    };
  }
}

class Style {
  constructor(ttl, dp) {
    this.ttl = ttl;
    this.dp = dp;
  }
}

class TextToSpeech {
  constructor(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt) {
    this.textProcessor = textProcessor;
    this.dpOrt = dpOrt;
    this.textEncOrt = textEncOrt;
    this.vectorEstOrt = vectorEstOrt;
    this.vocoderOrt = vocoderOrt;
    this.sampleRate = cfgs.ae.sample_rate;
    this.baseChunkSize = cfgs.ae.base_chunk_size;
    this.chunkCompressFactor = cfgs.ttl.chunk_compress_factor;
    this.latentDimension = cfgs.ttl.latent_dim;
  }

  sampleNoisyLatent(duration) {
    const maxWaveLength = Math.max(...duration) * this.sampleRate;
    const waveLengths = duration.map((value) => Math.floor(value * this.sampleRate));
    const chunkSize = this.baseChunkSize * this.chunkCompressFactor;
    const latentLength = Math.floor((maxWaveLength + chunkSize - 1) / chunkSize);
    const latentDimension = this.latentDimension * this.chunkCompressFactor;
    const noisyLatent = [];

    for (let batchIndex = 0; batchIndex < duration.length; batchIndex += 1) {
      const batch = [];
      for (let dimension = 0; dimension < latentDimension; dimension += 1) {
        const row = [];
        for (let timeIndex = 0; timeIndex < latentLength; timeIndex += 1) {
          const u1 = Math.max(1e-10, Math.random());
          const u2 = Math.random();
          row.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
        }
        batch.push(row);
      }
      noisyLatent.push(batch);
    }

    const latentMask = getLatentMask(waveLengths, this.baseChunkSize, this.chunkCompressFactor);
    for (let batchIndex = 0; batchIndex < noisyLatent.length; batchIndex += 1) {
      for (let dimension = 0; dimension < noisyLatent[batchIndex].length; dimension += 1) {
        for (let timeIndex = 0; timeIndex < noisyLatent[batchIndex][dimension].length; timeIndex += 1) {
          noisyLatent[batchIndex][dimension][timeIndex] *= latentMask[batchIndex][0][timeIndex];
        }
      }
    }

    return { noisyLatent, latentMask };
  }

  async infer(textList, langList, style, totalStep, speed) {
    if (textList.length !== style.ttl.dims[0]) {
      throw new Error("The number of texts must match the voice style batch.");
    }

    const batchSize = textList.length;
    const { textIds, textMask } = this.textProcessor.call(textList, langList);
    const textIdsShape = [batchSize, textIds[0].length];
    const textMaskShape = [batchSize, 1, textMask[0][0].length];
    const textMaskTensor = floatTensor(textMask, textMaskShape);

    const durationResult = await this.dpOrt.run({
      text_ids: intTensor(textIds, textIdsShape),
      style_dp: style.dp,
      text_mask: textMaskTensor
    });
    const duration = Array.from(durationResult.duration.data).map((value) => value / speed);

    const textEmbeddingResult = await this.textEncOrt.run({
      text_ids: intTensor(textIds, textIdsShape),
      style_ttl: style.ttl,
      text_mask: textMaskTensor
    });

    const { noisyLatent, latentMask } = this.sampleNoisyLatent(duration);
    const latentShape = [batchSize, noisyLatent[0].length, noisyLatent[0][0].length];
    const latentMaskShape = [batchSize, 1, latentMask[0][0].length];
    const latentMaskTensor = floatTensor(latentMask, latentMaskShape);
    const scalarShape = [batchSize];
    const totalStepTensor = floatTensor(new Array(batchSize).fill(totalStep), scalarShape);

    for (let step = 0; step < totalStep; step += 1) {
      const estimate = await this.vectorEstOrt.run({
        noisy_latent: floatTensor(noisyLatent, latentShape),
        text_emb: textEmbeddingResult.text_emb,
        style_ttl: style.ttl,
        text_mask: textMaskTensor,
        latent_mask: latentMaskTensor,
        total_step: totalStepTensor,
        current_step: floatTensor(new Array(batchSize).fill(step), scalarShape)
      });

      const denoised = Array.from(estimate.denoised_latent.data);
      let offset = 0;
      for (let batchIndex = 0; batchIndex < noisyLatent.length; batchIndex += 1) {
        for (let dimension = 0; dimension < noisyLatent[batchIndex].length; dimension += 1) {
          for (let timeIndex = 0; timeIndex < noisyLatent[batchIndex][dimension].length; timeIndex += 1) {
            noisyLatent[batchIndex][dimension][timeIndex] = denoised[offset];
            offset += 1;
          }
        }
      }
    }

    const vocoderResult = await this.vocoderOrt.run({
      latent: floatTensor(noisyLatent, latentShape)
    });
    return {
      wav: Array.from(vocoderResult.wav_tts.data),
      duration
    };
  }

  async call(text, lang, style, totalStep, speed = 1.05, silenceDuration = 0.3) {
    if (style.ttl.dims[0] !== 1) {
      throw new Error("Single voice synthesis expects one style.");
    }

    const maxLength = lang === "ko" || lang === "ja" ? 120 : 300;
    const chunks = chunkText(text, maxLength);
    let combined = null;
    let combinedDuration = 0;

    for (const chunk of chunks) {
      const result = await this.infer([chunk], [lang], style, totalStep, speed);
      if (combined === null) {
        combined = result.wav;
        combinedDuration = result.duration[0];
      } else {
        combined = [
          ...combined,
          ...new Array(Math.floor(silenceDuration * this.sampleRate)).fill(0),
          ...result.wav
        ];
        combinedDuration += silenceDuration + result.duration[0];
      }
    }

    return { wav: combined || [], duration: [combinedDuration] };
  }
}

function lengthToMask(lengths) {
  const maxLength = Math.max(...lengths);
  return lengths.map((length) => [Array.from({ length: maxLength }, (_value, index) => index < length ? 1 : 0)]);
}

function getLatentMask(waveLengths, baseChunkSize, chunkCompressFactor) {
  const latentSize = baseChunkSize * chunkCompressFactor;
  return lengthToMask(waveLengths.map((length) => Math.floor((length + latentSize - 1) / latentSize)));
}

function floatTensor(array, dimensions) {
  return new ort.Tensor("float32", Float32Array.from(array.flat(Infinity)), dimensions);
}

function intTensor(array, dimensions) {
  const flattened = array.flat(Infinity).map((value) => BigInt(value));
  return new ort.Tensor("int64", BigInt64Array.from(flattened), dimensions);
}

async function loadOnnxAll(onnxDirectory) {
  const options = {};
  const [duration, textEncoder, vectorEstimator, vocoder] = await Promise.all([
    ort.InferenceSession.create(path.join(onnxDirectory, "duration_predictor.onnx"), options),
    ort.InferenceSession.create(path.join(onnxDirectory, "text_encoder.onnx"), options),
    ort.InferenceSession.create(path.join(onnxDirectory, "vector_estimator.onnx"), options),
    ort.InferenceSession.create(path.join(onnxDirectory, "vocoder.onnx"), options)
  ]);

  return { duration, textEncoder, vectorEstimator, vocoder };
}

export async function loadTextToSpeech(onnxDirectory) {
  const cfgs = JSON.parse(fs.readFileSync(path.join(onnxDirectory, "tts.json"), "utf8"));
  const textProcessor = new UnicodeProcessor(path.join(onnxDirectory, "unicode_indexer.json"));
  const sessions = await loadOnnxAll(onnxDirectory);
  return new TextToSpeech(
    cfgs,
    textProcessor,
    sessions.duration,
    sessions.textEncoder,
    sessions.vectorEstimator,
    sessions.vocoder
  );
}

export function loadVoiceStyle(voiceStylePaths) {
  const firstStyle = JSON.parse(fs.readFileSync(voiceStylePaths[0], "utf8"));
  const ttlDims = firstStyle.style_ttl.dims;
  const dpDims = firstStyle.style_dp.dims;
  const ttlData = new Float32Array(voiceStylePaths.length * ttlDims[1] * ttlDims[2]);
  const dpData = new Float32Array(voiceStylePaths.length * dpDims[1] * dpDims[2]);

  voiceStylePaths.forEach((voiceStylePath, index) => {
    const voiceStyle = JSON.parse(fs.readFileSync(voiceStylePath, "utf8"));
    ttlData.set(voiceStyle.style_ttl.data.flat(Infinity), index * ttlDims[1] * ttlDims[2]);
    dpData.set(voiceStyle.style_dp.data.flat(Infinity), index * dpDims[1] * dpDims[2]);
  });

  return new Style(
    new ort.Tensor("float32", ttlData, [voiceStylePaths.length, ttlDims[1], ttlDims[2]]),
    new ort.Tensor("float32", dpData, [voiceStylePaths.length, dpDims[1], dpDims[2]])
  );
}

export function writeWavFile(fileName, audioData, sampleRate) {
  const bitsPerSample = 16;
  const dataSize = audioData.length * bitsPerSample / 8;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bitsPerSample / 8, 28);
  buffer.writeUInt16LE(bitsPerSample / 8, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  audioData.forEach((audioSample, index) => {
    const sample = Math.max(-1, Math.min(1, audioSample));
    buffer.writeInt16LE(Math.floor(sample * 32767), 44 + index * 2);
  });
  fs.writeFileSync(fileName, buffer);
}

function chunkText(text, maxLength) {
  if (typeof text !== "string") {
    throw new Error("Text must be a string.");
  }

  const chunks = [];
  for (const paragraph of text.trim().split(/\n\s*\n+/).filter(Boolean)) {
    let chunk = "";
    for (const sentence of paragraph.trim().split(/(?<=[.!?])\s+/)) {
      if (chunk.length + sentence.length + 1 <= maxLength) {
        chunk += `${chunk ? " " : ""}${sentence}`;
      } else {
        if (chunk) {
          chunks.push(chunk);
        }
        chunk = sentence;
      }
    }
    if (chunk) {
      chunks.push(chunk);
    }
  }
  return chunks;
}
