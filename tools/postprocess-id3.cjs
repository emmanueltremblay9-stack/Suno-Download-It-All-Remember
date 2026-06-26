#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const USAGE = `
Suno ID3 post-processor

Usage:
  node tools/postprocess-id3.cjs --input <export-folder> [--output <folder>] [--overwrite] [--dry-run]

Examples:
  node tools/postprocess-id3.cjs --input "C:\\Exports\\suno-batch"
  node tools/postprocess-id3.cjs --input "C:\\Exports\\suno-batch" --output "C:\\Exports\\tagged"
  node tools/postprocess-id3.cjs --input "C:\\Exports\\suno-batch" --overwrite
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.log(USAGE.trim());
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const inputRoot = path.resolve(args.input);
  const outputRoot = args.output ? path.resolve(args.output) : inputRoot;
  if (!fs.existsSync(inputRoot) || !fs.statSync(inputRoot).isDirectory()) {
    throw new Error(`Input folder does not exist: ${inputRoot}`);
  }
  if (!args.dryRun && !fs.existsSync(outputRoot)) {
    fs.mkdirSync(outputRoot, { recursive: true });
  }

  const NodeID3 = args.dryRun ? null : loadNodeID3();
  const files = walk(inputRoot);
  const metadataFiles = files.filter((file) => file.toLowerCase().endsWith(".json"));
  const mp3Index = indexByBase(files.filter((file) => file.toLowerCase().endsWith(".mp3")));
  const imageIndex = indexByBase(files.filter((file) => /\.(?:jpg|jpeg|png|webp)$/i.test(file)));
  const lyricIndex = indexByBase(files.filter((file) => file.toLowerCase().endsWith(".txt")));

  const results = [];
  for (const metadataFile of metadataFiles) {
    const metadata = readJson(metadataFile);
    if (!metadata || metadata.schema !== "suno-batch-exporter.metadata.v1") {
      continue;
    }
    results.push(processOne({
      NodeID3,
      metadata,
      metadataFile,
      inputRoot,
      outputRoot,
      mp3Index,
      imageIndex,
      lyricIndex,
      overwrite: args.overwrite,
      dryRun: args.dryRun
    }));
  }

  const ok = results.filter((result) => result.status === "success").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;

  for (const result of results) {
    const label = result.status.toUpperCase().padEnd(7);
    console.log(`${label} ${result.title} -> ${result.output || result.reason}`);
  }
  console.log(`Summary: ${ok} tagged, ${failed} failed, ${skipped} skipped.`);
  process.exitCode = failed ? 1 : 0;
}

function processOne(context) {
  const metadata = context.metadata;
  const title = metadata.title || path.basename(context.metadataFile, ".json");
  const baseName = metadata.baseName || path.basename(context.metadataFile, ".json");
  const mp3 = findRelatedFile(metadata.mp3FileName, baseName, context.mp3Index, ".mp3");
  if (!mp3) {
    return { status: "failed", title, reason: "No matching MP3 found." };
  }

  const outputFile = context.overwrite
    ? mp3
    : uniqueOutputPath(path.join(context.outputRoot, metadata.suggestedFileName || `${baseName}.mp3`));

  const lyrics = metadata.lyrics || readOptionalText(findRelatedFile(metadata.lyricsFileName, baseName, context.lyricIndex, ".txt"));
  const coverFile = findRelatedFile(metadata.coverFileName, baseName, context.imageIndex, "");
  const tags = buildTags(metadata, lyrics, coverFile);

  if (context.dryRun) {
    return { status: "skipped", title, output: outputFile, reason: "Dry run." };
  }

  if (!context.overwrite) {
    fs.copyFileSync(mp3, outputFile);
  }

  const success = context.NodeID3.write(tags, outputFile);
  if (success !== true) {
    return { status: "failed", title, output: outputFile, reason: String(success) };
  }

  return { status: "success", title, output: outputFile };
}

function buildTags(metadata, lyrics, coverFile) {
  const userDefinedText = [];
  const txxx = metadata.txxx || {};
  for (const [description, value] of Object.entries(txxx)) {
    if (value !== undefined && value !== null && String(value).trim()) {
      userDefinedText.push({ description, value: String(value) });
    }
  }

  const tags = {
    title: metadata.title || "Untitled Suno song",
    artist: metadata.artist || "SunoUser",
    unsynchronisedLyrics: {
      language: "eng",
      text: lyrics || ""
    },
    userDefinedText
  };

  if (metadata.creationDate) {
    tags.recordingTime = metadata.creationDate;
  }

  if (coverFile) {
    tags.image = {
      mime: mimeForImage(coverFile),
      type: { id: 3, name: "front cover" },
      description: "Suno cover art",
      imageBuffer: fs.readFileSync(coverFile)
    };
  }

  return tags;
}

function parseArgs(argv) {
  const args = { overwrite: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--input" || arg === "-i") {
      args.input = argv[++index];
    } else if (arg === "--output" || arg === "-o") {
      args.output = argv[++index];
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function loadNodeID3() {
  try {
    return require("node-id3");
  } catch (error) {
    throw new Error("Missing dependency node-id3. Run `pnpm install` or `npm install` in the project folder first.");
  }
}

function walk(root) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...walk(fullPath));
    } else if (entry.isFile()) {
      output.push(fullPath);
    }
  }
  return output;
}

function indexByBase(files) {
  const index = new Map();
  for (const file of files) {
    const base = path.basename(file).toLowerCase();
    index.set(base, file);
    index.set(path.basename(file, path.extname(file)).toLowerCase(), file);
  }
  return index;
}

function findRelatedFile(fileName, baseName, index, extension) {
  const candidates = [];
  if (fileName) {
    candidates.push(fileName, path.basename(fileName));
  }
  if (baseName) {
    candidates.push(`${baseName}${extension}`, baseName);
  }
  for (const candidate of candidates) {
    const clean = String(candidate).toLowerCase();
    if (index.has(clean)) {
      return index.get(clean);
    }
  }
  return "";
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readOptionalText(file) {
  if (!file) {
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function uniqueOutputPath(file) {
  if (!fs.existsSync(file)) {
    return file;
  }
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  for (let index = 2; index < 10000; index += 1) {
    const candidate = path.join(dir, `${stem} (${index})${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not find unused output path for ${file}`);
}

function mimeForImage(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  return "image/jpeg";
}

main();
