// Synthesised feedback, no sample files. This game's sound vocabulary is about *lines*: a row
// closing on M is the unit of progress, not a cell, so the ear gets a different shape for
// "a line just added up" than for "a digit went down". Each of those is one short envelope, so a
// synth keeps the artifact small and the vocabulary honest.

let ctx = null;
let master = null;
let enabled = true;

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

// One oscillator with a two-point pitch glide and an exponential decay. Everything below is a
// call to this; adding a second voice shape is how a game ends up with sounds that do not belong
// to the same instrument.
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  const ac = audio();
  if (!ac || !enabled) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
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
  setEnabled(v) {
    enabled = !!v;
  },
  enabled: () => enabled,

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
