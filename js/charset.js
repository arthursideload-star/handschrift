// Which characters the user can draw, and how typed text is normalised.

export const GROUPS = [
  { name: 'Kleinbuchstaben', chars: 'abcdefghijklmnopqrstuvwxyz' },
  { name: 'Großbuchstaben', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { name: 'Umlaute & ß', chars: 'äöüÄÖÜß¨' },
  { name: 'Ziffern', chars: '0123456789' },
  { name: 'Satzzeichen', chars: '.,;:!?-()"\'/' },
  { name: 'Mathe & Sonstiges', chars: '+=%&*<>[]{}@€§#_°^|~' },
];

export const ALL_CHARS = GROUPS.flatMap((g) => [...g.chars]);

export const HINTS = {
  '¨': 'Nur die zwei Umlaut-Punkte – so hoch, wie sie über einem kleinen „a“ stehen. Daraus baut die App ä, ö, ü, Ä, Ö, Ü, falls du die nicht einzeln zeichnest.',
  '.': 'Punkt auf der Grundlinie.',
  ',': 'Komma an der Grundlinie.',
  '-': 'Bindestrich auf halber x-Höhe.',
  '"': 'Anführungszeichen oben.',
  "'": 'Apostroph oben.',
};

// Umlauts can be composed from the base letter plus the "¨" glyph.
export const COMPOSE = {
  ä: ['a', '¨', 0],
  ö: ['o', '¨', 0],
  ü: ['u', '¨', 0],
  Ä: ['A', '¨', -0.5],
  Ö: ['O', '¨', -0.5],
  Ü: ['U', '¨', -0.5],
};

const REPLACE = [
  [/\r\n?/g, '\n'],
  [/[“”„‟«»″]/g, '"'],
  [/[‘’‚‛′´`]/g, "'"],
  [/[–—−‐‑]/g, '-'],
  [/…/g, '...'],
  [/[  -​  　\t]/g, ' '],
  [/×/g, 'x'],
  [/·|⋅/g, '*'],
  [/÷/g, ':'],
];

// Remove the Markdown / LaTeX decoration ChatGPT tends to add.
export function stripMarkdown(s) {
  return s
    .split('\n')
    .map((line) => {
      let l = line;
      l = l.replace(/^\s{0,3}#{1,6}\s+/, ''); // headings
      l = l.replace(/^\s*>\s?/, ''); // quotes
      l = l.replace(/^(\s*)[*+•]\s+/, '$1- '); // bullets
      l = l.replace(/^\s*([-*_])(\s*\1){2,}\s*$/, ''); // horizontal rules
      l = l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
      l = l.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s.,;:!?)]|$)/g, '$1$2'); // *italic*
      l = l.replace(/`+([^`]*)`+/g, '$1');
      l = l.replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1'); // links
      l = l.replace(/\\[()[\]]/g, ''); // \( \) \[ \]
      l = l.replace(/\$+/g, '');
      l = l.replace(/\\cdot/g, '*').replace(/\\times/g, 'x').replace(/\\div/g, ':');
      l = l.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
      l = l.replace(/\\sqrt\{([^{}]*)\}/g, 'Wurzel($1)');
      l = l.replace(/\\(left|right|,|;|!|quad|qquad)/g, '');
      return l;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function normalizeText(text, { stripMd = true } = {}) {
  let s = text || '';
  for (const [re, rep] of REPLACE) s = s.replace(re, rep);
  if (stripMd) s = stripMarkdown(s);
  return s.replace(/[ ]+\n/g, '\n').trim();
}
