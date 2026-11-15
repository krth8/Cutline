/** Text helpers for the palette: the same case and accent folding as the server (api/search.py), and highlighting. */

/** Lower-case and drop accents, keeping the length so indexes in the result fit the original text. */
export function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    const base = ch.normalize('NFD')[0] ?? ch;
    const low = base.toLowerCase();
    // A character that folds to a different length (e.g. an expanding letter) is kept as it is
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

/** The distinct folded words of a query. */
export function queryWords(query: string): string[] {
  const words: string[] = [];
  for (const word of fold(query.trim()).split(/\s+/)) if (word && !words.includes(word)) words.push(word);
  return words;
}

export interface TextPart {
  text: string;
  match: boolean;
}

/** `text` cut into parts, the ones that match a word of the query flagged (overlaps are merged). */
export function highlightParts(text: string, words: string[]): TextPart[] {
  if (!text) return [];
  if (words.length === 0) return [{ text, match: false }];
  const folded = fold(text);
  const marked = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + word.length)) {
      for (let i = at; i < at + word.length; i++) marked[i] = true;
    }
  }
  const parts: TextPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.match === marked[i]) last.text += text[i];
    else parts.push({ text: text[i]!, match: marked[i]! });
  }
  return parts;
}
