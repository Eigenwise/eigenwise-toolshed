const WORDS_IN_NAME = 5;
const WORDS_IN_BODY_LABEL = 8;
const LONGEST_NAME = 40;

export function slugify(name) {
  return name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "");
}

export function isNumericId(name) {
  return /^\d+$/.test(name);
}

export function deriveLabel(data, body) {
  const candidates = [data.description, firstHeading(body), firstWords(body)];
  const usable = candidates.find((candidate) => typeof candidate === "string" && slugify(candidate) !== "");
  return usable === undefined ? "" : usable.trim().replaceAll(/\s+/g, " ");
}

export function shortName(label) {
  const words = label.split(/\s+/).slice(0, WORDS_IN_NAME).join(" ");
  return slugify(words).slice(0, LONGEST_NAME).replace(/-+$/, "");
}

function firstHeading(body) {
  return body.match(/^#{1,6}\s+(.+)$/m)?.[1];
}

function firstWords(body) {
  const firstLine = body.split(/\r?\n/).find((line) => slugify(line) !== "") ?? "";
  const plain = firstLine.replaceAll(/[^\p{L}\p{N}\s'-]/gu, " ");
  return plain.split(/\s+/).filter(Boolean).slice(0, WORDS_IN_BODY_LABEL).join(" ");
}
