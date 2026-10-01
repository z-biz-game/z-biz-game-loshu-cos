// 动效层。它画在**另一张叠在棋盘之上的 canvas** 上，不是画在 #board 里。
//
// 为什么单独一张：这个仓的验收有 339 条断言是直接读 #board 像素的——"没合上的线还是白纸"
// 要求某格纸面像素与 cellPaper 的距离 ≤3，"被拒的那格一个像素都没多"要求某格的墨量计数
// 逐位相等。任何落在格子里的辉光都会把这两条判红，而它们判的是玩法反馈，不是好看与否。
// 叠层拿不到 view.ctx，天然互不干扰。
//
// 时间只从 step(dt) 进来，且只在定步长里被调用：粒子位移写成 x += v*dt，阻尼写成
// Math.pow(k, dt*60)。这里没有一处"每帧乘一个常数"——那是只在 60Hz 成立的写法。

import { Palette, prefersReducedMotion } from '../theme.js';

const TAU = Math.PI * 2;
// 定步长只有这一处定义：主循环按它喂仿真，帧率快慢只决定喂几次，不决定喂多大口。
export const SIM_STEP = 1 / 60;
const MAX_SPARKS = 140;
const SPARK_TTL = 0.85;
const RING_TTL = 0.7;
const ORBIT_PERIOD = 7.5; // 秒一圈：慢到不抢注意力，快到能看出盘是活的

const sprites = { spark: null, glow: null, ready: false };

// file:// 与沙箱里 new Image() 可能永远不 complete；draw 有矢量回落，所以缺贴图只是少了柔光，
// 不会少掉动效本身。
export function loadSprites() {
  if (sprites.ready || typeof Image !== 'function') return sprites;
  const base = typeof document === 'object' && document.baseURI ? document.baseURI : undefined;
  const pick = (name, slot) => {
    try {
      const img = new Image();
      img.onload = () => { sprites.ready = !!(sprites.spark && sprites.glow); };
      img.src = base ? new URL(`assets/img/${name}`, base).href : `assets/img/${name}`;
      sprites[slot] = img;
    } catch {
      /* 拿不到精灵就走矢量回落 */
    }
  };
  pick('spark.png', 'spark');
  pick('glow.png', 'glow');
  return sprites;
}

export class FxLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext ? canvas.getContext('2d') : null;
    this.geo = { w: 0, h: 0, dpr: 1 };
    this.reset();
  }

  // 复位是"再来一局"的一部分：时钟、粒子、涟漪一个都不许留。
  reset() {
    this.clock = 0;
    this.steps = 0;
    this.sparks = [];
    this.rings = [];
    this.orbit = 0;
  }

  clearMotion() {
    this.sparks.length = 0;
    this.rings.length = 0;
  }

  resize(wCss, hCss, dpr) {
    const d = Math.max(1, Math.round(dpr || 1));
    this.geo = { w: wCss, h: hCss, dpr: d };
    if (!this.canvas) return;
    this.canvas.style.width = `${wCss}px`;
    this.canvas.style.height = `${hCss}px`;
    this.canvas.width = Math.round(wCss * d);
    this.canvas.height = Math.round(hCss * d);
    if (this.ctx) this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  // 省掉的只是粒子与环绕光，不是"反馈"：合线的那圈涟漪在 reduce-motion 下退化成一次静描边。
  get reduced() {
    return prefersReducedMotion();
  }

  burst(x, y, count, color) {
    if (this.reduced || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
    let made = 0;
    for (let i = 0; i < count && this.sparks.length < MAX_SPARKS; i++) {
      const a = Math.random() * TAU;
      const v = 26 + Math.random() * 74;
      this.sparks.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: SPARK_TTL * (0.6 + Math.random() * 0.4),
        ttl: SPARK_TTL,
        size: 2.4 + Math.random() * 3.6,
        color: color || Palette.accent,
      });
      made++;
    }
    return made;
  }

  ring(x, y, r0, r1, color) {
    if (this.reduced || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const r = { x, y, r0, r1, life: RING_TTL, ttl: RING_TTL, color: color || Palette.accent };
    this.rings.push(r);
    return r;
  }

  // 一条线合上：从它的和块位置炸一次，再推一圈涟漪。和块本来就画在边距里，动效也留在边距。
  celebrate(rect, color) {
    if (!rect) return;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    this.burst(cx, cy, 14, color);
    this.ring(cx, cy, Math.max(rect.w, rect.h) * 0.5, Math.max(rect.w, rect.h) * 2.1, color);
  }

  step(dt) {
    this.clock += dt;
    this.steps++;
    this.orbit = (this.orbit + dt / ORBIT_PERIOD) % 1;

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.sparks.splice(i, 1);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const damp = Math.pow(0.9, dt * 60);
      s.vx *= damp;
      s.vy *= damp;
      s.vy += 26 * dt;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      if (r.life <= 0) this.rings.splice(i, 1);
    }
  }

  get alive() {
    return this.sparks.length > 0 || this.rings.length > 0 || !this.reduced;
  }

  // 摘要给窗口状态面用：任何外部尺子都能读到"这一帧的动效真的在随时长变化"。
  summary() {
    return {
      clock: this.clock,
      steps: this.steps,
      sparks: this.sparks.length,
      rings: this.rings.length,
      orbit: this.orbit,
      ink: this.sparks.reduce((n, s) => n + s.x + s.y, 0),
    };
  }

  draw(boardGeo) {
    const { ctx } = this;
    if (!ctx || !this.geo.w) return;
    ctx.clearRect(0, 0, this.geo.w, this.geo.h);
    if (!boardGeo || !boardGeo.cell) return;
    const { cell, x: ox, y: oy, n } = boardGeo;
    const side = cell * n;

    // 环绕光：沿着盘的外圈边距走，永远不进格子内部（那是像素断言的地盘）。
    if (!this.reduced) {
      const t = this.orbit * TAU;
      const cx = ox + side / 2;
      const cy = oy + side / 2;
      const rx = side / 2 + boardGeo.m * 0.42;
      const ry = side / 2 + boardGeo.m * 0.42;
      const px = cx + Math.cos(t) * rx;
      const py = cy + Math.sin(t) * ry;
      const a = 0.16 + 0.1 * (0.5 + 0.5 * Math.sin(t * 2));
      this.blit(sprites.glow, px, py, cell * 1.5, a, Palette.diagInk);
    }

    for (const r of this.rings) {
      const k = 1 - r.life / r.ttl;
      const rad = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 2.2));
      ctx.globalAlpha = Math.max(0, r.life / r.ttl) * 0.55;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, cell * 0.05 * (1 - k));
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, TAU);
      ctx.stroke();
    }

    for (const s of this.sparks) {
      const k = s.life / s.ttl;
      this.blit(sprites.spark, s.x, s.y, s.size * (1.6 + k * 2.4), Math.min(1, k * 1.15), s.color);
    }
    ctx.globalAlpha = 1;
  }

  // 精灵缺失时画方块/圆点：沙箱与 file:// 里动效照样成立。
  blit(img, x, y, size, alpha, color) {
    const { ctx } = this;
    if (!Number.isFinite(x) || !Number.isFinite(y) || size <= 0) return;
    ctx.globalAlpha = alpha;
    if (img && img.complete && img.naturalWidth) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
      ctx.globalCompositeOperation = 'source-over';
      return;
    }
    ctx.fillStyle = color || Palette.accent;
    ctx.beginPath();
    ctx.arc(x, y, size * 0.28, 0, TAU);
    ctx.fill();
  }
}
