// Single source of truth for colour, spacing and motion. The stylesheet reads these as custom
// properties (applyThemeVars) and the canvas reads the same objects, so a token cannot change on
// one side only — which is how "the player's ink" and "the printed clue" stay two different
// colours in a 500-line file instead of forty.

export const Palette = {
  bgTop: '#070A12',
  bgBottom: '#111A28',
  surface: '#0E1622',
  surfaceLift: '#16212F',
  line: '#233047',
  lineHeavy: '#3C4E6B',
  ink: '#F3F6FA',
  inkDim: 'rgba(243,246,250,0.62)',
  inkFaint: 'rgba(243,246,250,0.34)',

  // Amber is the player's own hand. The digit they typed, the cell under the cursor and the win
  // banner all borrow it, so "this much of the board is yours" reads as one idea.
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',

  // The printed givens stay cooler and quieter than amber: a puzzle whose clues shout is a
  // puzzle that looks half-solved before the first move.
  given: '#9FB4CE',
  givenSoft: 'rgba(159,180,206,0.10)',

  cellPaper: '#0B1220',
  cellAlt: '#0E1727',

  success: '#3DDC91',
  error: '#FF5C7A',
  warn: '#FFB05C',
  info: '#7BB8FF',
  hint: '#7BB8FF',
  focus: 'rgba(123,184,255,0.16)',

  // A note is a thought, not a decision: it is drawn in pencil, and the engine never reads it.
  pencil: 'rgba(243,246,250,0.30)',

  // Line states. The whole game is these lines, so the wash along a line is the primary
  // readout of progress — one colour per judgement, never one per cell.
  lineDone: 'rgba(61,220,145,0.13)',
  lineOpen: 'rgba(123,184,255,0.06)',
  lineBad: 'rgba(255,92,122,0.16)',
  chipDone: '#3DDC91',
  chipBad: '#FF5C7A',
  chipOpen: '#6F8299',

  // Rows and columns are the plain paper lines; the diagonal families get their own hue so a
  // 泛对角 board can be read without a legend hunt.
  diagInk: '#7BB8FF',
  panInk: '#B08CFF',
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 20, button: 12, chip: 8, cell: 4 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
  // Digits are the board's content; tabular figures keep 1..16 the same width so a column of
  // them cannot shimmer as the sums change.
  digits: "700 %px 'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
};

// Durations obey the 150–350 ms discipline; anything longer blocks the next move.
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  line: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

export const Cell = {
  min: 26,
  max: 78,
  digitScale: 0.44,
  noteScale: 0.19,
  // The margin around the grid is where the lines are read: a row's running sum lives to the
  // right of the row, a column's below the column. It is not decoration, so it is sized from
  // the cell rather than fixed.
  marginScale: 0.72,
  marginMin: 30,
};

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) root.setProperty('--' + kebab(k), v);
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// The system preference is the floor, and the in-game toggle can only add to it — a player who
// asks for less motion should not be overruled by an OS set to "no preference".
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
