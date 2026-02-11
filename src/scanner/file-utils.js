import fs from "fs";

export function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function readText(file) {
  if (!fs.existsSync(file)) return "";
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

function safeParseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function readJsonlTail(file, max = 10) {
  if (!fs.existsSync(file)) return [];
  let raw = "";
  try {
    const stat = fs.statSync(file);
    const tailBytes = Math.min(stat.size, 256 * 1024);
    const start = Math.max(0, stat.size - tailBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(tailBytes);
    fs.readSync(fd, buffer, 0, tailBytes, start);
    fs.closeSync(fd);
    raw = buffer.toString("utf-8");
  } catch {
    raw = readText(file);
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return lines.slice(Math.max(0, lines.length - max)).map(safeParseJsonLine).filter(Boolean);
}

export function isoToMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
