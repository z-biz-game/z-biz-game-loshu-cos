// Synthesised feedback, no sample files. This game's sound vocabulary is about *lines*: a row
// closing on M is the unit of progress, not a cell, so the ear gets a different shape for
// "a line just added up" than for "a digit went down". Each of those is one short envelope, so a
// synth keeps the artifact small and the vocabulary honest.

let ctx = null;
let master = null;
let enabled = true;
let halted = false;

const silent = () => !enabled || halted;

function audio() {
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
  if (!ctx) {
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// 静音与暂停都要真的把设备上下文停掉：只把 gain 设 0 是假静音，硬件仍在跑，
// 而且下一次 tone() 还会照样新建振荡器节点。
function applyAudioState() {
  if (!ctx) return;
  try {
    if (silent()) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  } catch {
    /* 老 WebKit 上 suspend 可能是同步的或压根没有 */
  }
}

// One oscillator with a two-point pitch glide and an exponential decay. Everything below is a
// call to this; adding a second voice shape is how a game ends up with sounds that do not belong
// to the same instrument.
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  // 静音态连上下文都不拉起：判据是"没新建振荡器"，不是"听起来没声"。
  if (silent()) return;
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  Sound.nodesCreated++;
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const Sound = {
  // 实测口径：静音/暂停期间这个数必须一动不动。只把 gain 设 0 的实现会照样往上加。
  nodesCreated: 0,

  setEnabled(v) {
    enabled = !!v;
    applyAudioState();
  },
  enabled: () => enabled,

  // 暂停是另一个独立的静音理由：玩家把音效开着暂停，上下文也该停。
  halt() {
    halted = true;
    applyAudioState();
  },
  unhalt() {
    halted = false;
    applyAudioState();
  },
  halted: () => halted,

  probe: () => ({
    enabled,
    halted,
    nodesCreated: Sound.nodesCreated,
    ctxState: ctx ? ctx.state : 'none',
  }),

  // A digit going down: short, dry, one voice — the board is paper, not a slot machine.
  place() {
    tone({ f0: 520, f1: 660, dur: 0.09, type: 'triangle', gain: 0.16 });
  },
  note() {
    tone({ f0: 300, f1: 250, dur: 0.06, type: 'square', gain: 0.06 });
  },
  erase() {
    tone({ f0: 260, f1: 190, dur: 0.08, type: 'sine', gain: 0.1 });
  },
  undo() {
    tone({ f0: 420, f1: 300, dur: 0.11, type: 'triangle', gain: 0.13 });
  },
  // The sound a rejection has to have: the same two detuned voices as a dead line, because both
  // are the board saying "that is not allowed", and an invalid gesture is never silent.
  reject() {
    tone({ f0: 190, f1: 150, dur: 0.14, type: 'sawtooth', gain: 0.1 });
    tone({ f0: 203, f1: 158, dur: 0.14, type: 'sawtooth', gain: 0.08, delay: 0.012 });
  },
  // A line closing on M — the rising third is the game's real "correct" signal.
  lineClose() {
    tone({ f0: 660, dur: 0.1, type: 'sine', gain: 0.14 });
    tone({ f0: 830, dur: 0.14, type: 'sine', gain: 0.12, delay: 0.06 });
  },
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.16, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 214, f1: 158, dur: 0.16, type: 'sawtooth', gain: 0.09, delay: 0.01 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.26, type: 'triangle', gain: 0.17, delay: i * 0.09 }));
  },
};
