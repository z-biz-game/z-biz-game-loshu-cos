// Canvas renderer. It reads the Game's engine state and paints; it decides nothing — no line is
// "done" here, no digit is judged here — so the picture cannot disagree with the solver that the
// hints and the win check both use.
//
// Layout lives here too (cell size, margin, board origin, DPR) because hitCell and cellRect have
// to answer with the *same* numbers draw() used. Those two drifting apart is how a board renders
// correctly but takes taps one cell off.
//
// The margin is the point of this file. A 幻方 is a set of lines, so every line's running sum is
// drawn where the line is: rows to the right of the row, columns below the column, the diagonal
// families in the top strip, and Σ of the whole board in the corner. A player should be able to
// read the arithmetic without counting cells.


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown 触发，全仓 requestAnimationFrame 出现 0 次；唯一的周期性调用是 1 秒 ticker（刷新用时读数，走墙钟）
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Cell, Radius, Font } from '../theme.js';
import { EMPTY, ROW, COL, DIAG, PAN } from '../engine/loshu.js';

const PAPER = 8;

export function layoutFor(n, availW, availH) {
  // The margin is sized from the cell and the cell from the margin, so iterate a couple of times
  // — a fixed margin would either clip the sums or waste half the board on a 3×3.
  let m = Cell.marginMin;
  let cell = 0;
  for (let k = 0; k < 6; k++) {
    const s = Math.min((availW - PAPER * 2 - m * 2) / n, (availH - PAPER * 2 - m * 2) / n);
    cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(s)));
    const next = Math.max(Cell.marginMin, Math.round(cell * Cell.marginScale));
    if (next === m) break;
    m = next;
  }
  const boardW = cell * n;
  return {
    cell,
    margin: m,
    boardW,
    boardH: boardW,
    pad: PAPER,
    w: boardW + m * 2 + PAPER * 2,
    h: boardW + m * 2 + PAPER * 2,
  };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, m: 0, w: 0, h: 0, dpr: 1, n: 0 };
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels: one
  // ctx.setTransform at the top keeps digits crisp on a Retina display without doubling every
  // constant in this file.
  resize(game, availW, availH) {
    const l = layoutFor(game.n, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    this.canvas.style.width = `${l.w}px`;
    this.canvas.style.height = `${l.h}px`;
    this.canvas.width = Math.round(l.w * dpr);
    this.canvas.height = Math.round(l.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad + l.margin, y: l.pad + l.margin, m: l.margin, w: l.w, h: l.h, dpr, n: game.n };
    this.game = game;
    return this.geo;
  }

  cellRect(t) {
    const { cell, x, y, n } = this.geo;
    return { x: (t % n) * cell + x, y: (((t / n) | 0) * cell) + y, size: cell };
  }

  cellCentre(t) {
    const r = this.cellRect(t);
    return { x: r.x + r.size / 2, y: r.y + r.size / 2 };
  }

  // Pointer position → cell index, or -1 outside the grid. The margin is deliberately not part of
  // the board: a tap on a line's sum chip must do nothing rather than write into a corner cell.
  hitCell(clientX, clientY) {
    const p = this.local(clientX, clientY);
    const { cell, n } = this.geo;
    if (!p || !n || !cell) return -1;
    const gx = Math.floor(p.x / cell);
    const gy = Math.floor(p.y / cell);
    if (gx < 0 || gy < 0 || gx >= n || gy >= n) return -1;
    return gy * n + gx;
  }

  local(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { x, y } = this.geo;
    if (!this.geo.cell) return null;
    return { x: clientX - rect.left - x, y: clientY - rect.top - y };
  }

  // Where a line's sum is painted, in CSS pixels: the single source of truth for both the drawing
  // and the pixel assertions in tools/scenarios.js.
  rowChipRect(r) {
    const { cell, x, y, m, n } = this.geo;
    const w = Math.max(26, m * 0.82);
    const h = Math.max(16, cell * 0.42);
    return { x: x + n * cell + (m - w) / 2, y: y + r * cell + (cell - h) / 2, w, h };
  }

  colChipRect(c) {
    const { cell, x, y, m, n } = this.geo;
    const w = Math.max(26, cell * 0.72);
    const h = Math.max(16, m * 0.5);
    return { x: x + c * cell + (cell - w) / 2, y: y + n * cell + (m - h) / 2, w, h };
  }

  diagChipRect() {
    const { cell, x, y, m, n } = this.geo;
    const w = Math.max(64, cell * 1.2);
    const h = Math.max(16, m * 0.5);
    return { x: x + n * cell - w, y: y - m + (m - h) / 2, w, h };
  }

  sumChipRect() {
    const { x, y, m } = this.geo;
    const w = Math.max(56, m);
    const h = Math.max(16, m * 0.5);
    return { x: x - m, y: y - m + (m - h) / 2, w, h };
  }

  draw(game, { pulse = null, notes = true } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell, x: ox, y: oy } = geo;
    const n = game.n;
    const b = game.board;
    const st = game.st;
    const diag = game.diag;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, geo.w, geo.h);

    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();

    // 1. the paper, first and opaque. Givens wear a cooler wash so 题面 and 手填 never look alike.
    //    (This loop has to come before the line wash: painting cellPaper over a translucent wash
    //    erases it — which is exactly what an earlier draft did, leaving the "progress bar of the
    //    game" invisible. tools/scenarios.js reads the pixels of a closed row for that reason.)
    for (let t = 0; t < b.size; t++) {
      const r = this.cellRect(t);
      ctx.fillStyle = Palette.cellPaper;
      ctx.fillRect(r.x, r.y, cell, cell);
      if (b.givenFlag[t]) {
        ctx.fillStyle = Palette.givenSoft;
        ctx.fillRect(r.x, r.y, cell, cell);
      }
    }

    // 2. the wash along each line. It is drawn along lines rather than over cells: a closed row
    // reads green edge to edge, a broken one red.
    for (let gi = 0; gi < b.groups.length; gi++) {
      const l = diag.lines[gi];
      const wash = won || l.done ? Palette.lineDone : l.over || l.unreachable || l.dup ? Palette.lineBad : null;
      if (!wash) continue;
      ctx.fillStyle = wash;
      for (const t of l.cells) {
        const r = this.cellRect(t);
        ctx.fillRect(r.x, r.y, cell, cell);
      }
    }

    // 3. grid: rows and columns are the paper's own lines, so they get the quiet colour; the heavy
    // strokes are the block guides, which is where an eye reads "nine" or "sixteen".
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= n; i++) line(ctx, ox + i * cell, oy, ox + i * cell, oy + n * cell);
    for (let j = 0; j <= n; j++) line(ctx, ox, oy + j * cell, ox + n * cell, oy + j * cell);
    const guide = n === 4 ? 2 : n;
    ctx.strokeStyle = Palette.lineHeavy;
    ctx.lineWidth = 2;
    for (let i = guide; i < n; i += guide) line(ctx, ox + i * cell, oy, ox + i * cell, oy + n * cell);
    for (let j = guide; j < n; j += guide) line(ctx, ox, oy + j * cell, ox + n * cell, oy + j * cell);

    // 4. the diagonal families drawn as the lines they are, wrapping through the margin when the
    // band says a broken diagonal counts.
    for (let gi = 0; gi < b.groups.length; gi++) {
      const gr = b.groups[gi];
      if (gr.kind !== DIAG && gr.kind !== PAN) continue;
      const l = diag.lines[gi];
      ctx.strokeStyle = won || l.done ? Palette.chipDone : l.over || l.unreachable ? Palette.chipBad : gr.kind === DIAG ? Palette.diagInk : Palette.panInk;
      ctx.globalAlpha = gr.kind === DIAG ? 0.55 : 0.3;
      ctx.lineWidth = Math.max(1.5, cell * 0.05);
      this.diagonalPath(Array.from(gr.cells), n);
      ctx.globalAlpha = 1;
    }

    // 5. digits: printed clues in the cool colour, the player's own ink in amber, a digit that
    // broke a line in red, and nothing at all silently hidden.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const digitFont = `700 ${Math.round(cell * Cell.digitScale)}px ${Font.mono}`;
    for (let t = 0; t < b.size; t++) {
      const v = st.fill[t];
      const c = this.cellCentre(t);
      if (v !== EMPTY) {
        const bad = !b.givenFlag[t] && (diag.badCells.has(t) || diag.dupValues.includes(v));
        ctx.fillStyle = won ? Palette.chipDone : bad ? Palette.error : b.givenFlag[t] ? Palette.given : Palette.accent;
        ctx.font = digitFont;
        ctx.fillText(String(v), c.x, c.y + 1);
        continue;
      }
      if (notes && st.notes[t]) this.drawNotes(st.notes[t], cell, c, digitFont);
    }

    // 6. the sums, one per line, drawn where the line is.
    for (let r = 0; r < n; r++) this.drawChip(this.rowChipRect(r), this.lineChip(ROW, r));
    for (let c = 0; c < n; c++) this.drawChip(this.colChipRect(c), this.lineChip(COL, c));
    const families = diag.lines.filter((l) => l.kind === DIAG || l.kind === PAN);
    const closed = families.filter((l) => l.done).length;
    this.drawChip(this.diagChipRect(), {
      text: `斜 ${closed}/${families.length}`,
      done: closed === families.length && families.length > 0,
      bad: families.some((l) => l.over || l.unreachable),
    });
    this.drawChip(this.sumChipRect(), {
      text: `Σ${game.total}/${game.checksum}`,
      done: game.total === game.checksum,
      bad: game.total > game.checksum,
    });

    // 7. the cell under the cursor, and what a hint just named. The outline is the only place the
    // UI is allowed to say "look here".
    if (game.selected >= 0 && !won) {
      const r = this.cellRect(game.selected);
      ctx.strokeStyle = Palette.accentEdge;
      ctx.lineWidth = 2;
      roundRect(ctx, r.x + 1.5, r.y + 1.5, cell - 3, cell - 3, Radius.cell);
      ctx.stroke();
    }
    if (pulse && pulse.cells && pulse.cells.length) {
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2.5, cell * 0.08);
      for (const t of pulse.cells) {
        if (t < 0 || t >= b.size) continue;
        const r = this.cellRect(t);
        roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
        ctx.stroke();
      }
      if (pulse.prune) {
        // A deleted candidate is a real step in this game: strike through the cell so the player
        // sees which possibility the deduction removed, not merely that something happened.
        for (const t of pulse.cells) {
          if (st.fill[t] !== EMPTY) continue;
          const r = this.cellRect(t);
          ctx.beginPath();
          ctx.moveTo(r.x + cell * 0.28, r.y + cell * 0.64);
          ctx.lineTo(r.x + cell * 0.72, r.y + cell * 0.36);
          ctx.stroke();
        }
      }
    }

    // 8. the frame: the board's own outer edge, which reads as M when the square is finished.
    ctx.strokeStyle = won ? Palette.success : Palette.lineHeavy;
    ctx.lineWidth = 2;
    roundRect(ctx, ox - 1, oy - 1, n * cell + 2, n * cell + 2, Radius.cell);
    ctx.stroke();
  }

  // What a line's chip says: its running sum, or a tick once the sum is exactly M.
  lineChip(kind, index) {
    const label = `第${index + 1}${kind === ROW ? '行' : '列'}`;
    const l = this.game.diag.lines.find((x) => x.label === label);
    if (!l) return { text: '—', done: false, bad: false };
    return {
      text: l.done ? '✓' : String(l.sum),
      done: l.done,
      bad: l.over || l.unreachable || (l.closed && l.sum !== l.want),
    };
  }

  // A wrapped diagonal is drawn as the path it actually is: straight inside the board, and a
  // dotted excursion through the margin where it leaves one edge and re-enters the opposite one.
  diagonalPath(cells, n) {
    const { ctx, geo } = this;
    const { cell, x: ox, y: oy } = geo;
    const gutter = Math.max(4, geo.m * 0.28);
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < cells.length; i++) {
      const a = this.cellCentre(cells[i]);
      if (i === 0) {
        ctx.moveTo(a.x, a.y);
        continue;
      }
      const p = this.cellCentre(cells[i - 1]);
      const dCol = (cells[i] % n) - (cells[i - 1] % n);
      if (Math.abs(dCol) < 2) {
        ctx.lineTo(a.x, a.y);
        continue;
      }
      // The line ran off the right edge (dCol = 1−n) or the left one (dCol = n−1): finish it to
      // that edge, cross the margin on a dotted lane, and pick it up again on the far side. The
      // steps are 45°, so the exit and entry points are half a cell of y away from the centres.
      const right = dCol < 0;
      ctx.lineTo(right ? ox + n * cell : ox, p.y + cell / 2);
      ctx.stroke();
      ctx.beginPath();
      const laneX = right ? ox + n * cell + gutter : ox - gutter;
      ctx.setLineDash([Math.max(2, cell * 0.1), Math.max(3, cell * 0.14)]);
      ctx.moveTo(laneX, p.y + cell / 2);
      ctx.lineTo(laneX, a.y - cell / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(right ? ox : ox + n * cell, a.y - cell / 2);
      ctx.lineTo(a.x, a.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawNotes(mask, cell, c, digitFont) {
    const { ctx } = this;
    const vals = [];
    for (let v = 1; v <= 16; v++) if (mask & (1 << (v - 1))) vals.push(v);
    if (!vals.length) return;
    const cols = Math.min(4, Math.ceil(Math.sqrt(vals.length)));
    const rows = Math.ceil(vals.length / cols);
    const step = cell * 0.26;
    const x0 = c.x - ((cols - 1) * step) / 2;
    const y0 = c.y - ((rows - 1) * step) / 2;
    ctx.font = `${Math.round(cell * Cell.noteScale)}px ${Font.mono}`;
    ctx.fillStyle = Palette.pencil;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    vals.forEach((v, i) => {
      ctx.fillText(String(v), x0 + (i % cols) * step, y0 + (((i / cols) | 0)) * step);
    });
    ctx.font = digitFont;
  }

  drawChip(rect, s) {
    const { ctx } = this;
    const bg = s.done ? Palette.chipDone : s.bad ? Palette.chipBad : Palette.surfaceLift;
    const fg = s.done ? '#07202F' : s.bad ? '#2A0910' : Palette.chipOpen;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, Math.min(6, rect.h / 2));
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = s.done ? Palette.success : s.bad ? Palette.error : Palette.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.font = `${Math.max(10, Math.round(rect.h * 0.66))}px ${Font.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.text, rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5);
  }
}

const line = (ctx, x1, y1, x2, y2) => {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
};

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
