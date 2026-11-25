const MAX_SKILL_DESCRIPTION_LENGTH = 200;
const WORD_ALTERNATIVE = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

export function splitKeywords(keywords) {
  const words = [];
  const unconverted = [];
  for (const keyword of keywords) {
    const plain = plainWordsOf(keyword);
    if (plain === null) unconverted.push(keyword);
    else words.push(...plain);
  }
  return { words: [...new Set(words)], unconverted };
}

export function plainWordsOf(keyword) {
  const alternatives = patternBody(keyword).split("|").map((alternative) => alternative.trim());
  return alternatives.every((alternative) => WORD_ALTERNATIVE.test(alternative)) ? alternatives : null;
}

function patternBody(keyword) {
  const literal = keyword.match(/^\/(.+)\/[dgimsuvy]*$/);
  return (literal ? literal[1] : keyword)
    .replace(/^\\b/, "")
    .replace(/\\b$/, "")
    .replace(/^\((?:\?:)?(.*)\)$/, "$1");
}

export function skillDescription(topic, words) {
  const sentence = topic.replace(/[.\s]+$/, "");
  const fitting = wordsThatFit(sentence, words);
  return mentionSentence(sentence, fitting).slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
}

function wordsThatFit(sentence, words) {
  let count = words.length;
  while (count > 0 && mentionSentence(sentence, words.slice(0, count)).length > MAX_SKILL_DESCRIPTION_LENGTH) count -= 1;
  return words.slice(0, count);
}

function mentionSentence(sentence, words) {
  if (words.length === 0) return sentence;
  return `${sentence}. Use when the request mentions ${joinWithOr(words)}.`;
}

function joinWithOr(words) {
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}
