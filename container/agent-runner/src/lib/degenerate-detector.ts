/**
 * Degenerate content detection for LLM thinking blocks.
 * Identifies low-entropy / high-repeat patterns that indicate
 * model token degeneration (e.g. CmgCmg…, SSSS…, +++…).
 */

export interface DegenerateResult {
  degenerate: boolean;
  entropy?: number;
  topNgramRatio?: number;
}

const MIN_LENGTH = 200;
const ENTROPY_THRESHOLD = 2.0;
const NGRAM_RATIO_THRESHOLD = 0.4;

/**
 * Check if text content is degenerate (low-entropy repeating tokens).
 * Two checks:
 *   1. Shannon entropy < 2.0 bits/char
 *   2. Most frequent 3-gram accounts for > 40% of content
 * Both are O(n) single-pass. Negligible cost.
 */
export function isDegenerate(text: string): DegenerateResult {
  if (text.length < MIN_LENGTH) return { degenerate: false };

  // Shannon entropy (character-level)
  const freq: Record<string, number> = {};
  for (const ch of text) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  if (entropy < ENTROPY_THRESHOLD) {
    return { degenerate: true, entropy };
  }

  // N-gram repetition ratio (3-char ngrams)
  const ngrams: Record<string, number> = {};
  for (let i = 0; i < text.length - 2; i++) {
    const ng = text.slice(i, i + 3);
    ngrams[ng] = (ngrams[ng] || 0) + 1;
  }
  const maxCount = Math.max(...Object.values(ngrams));
  const topNgramRatio = (maxCount * 3) / text.length;
  if (topNgramRatio > NGRAM_RATIO_THRESHOLD) {
    return { degenerate: true, entropy, topNgramRatio };
  }

  return { degenerate: false, entropy, topNgramRatio };
}
