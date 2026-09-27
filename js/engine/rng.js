// Seeded, reproducible randomness. Every puzzle in this game is addressed by a seed string,
// so a resume, a daily board and the verifier all agree on what "that 四四 puzzle" is.

export function hash32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Math.imul is exactly what 32-bit wrapping multiplication needs; the fallback keeps the
// hash honest on any host without one (a silent x*y truncation would change every seed).
function imul(a, b) {
  if (typeof Math.imul === 'function') return Math.imul(a, b);
  return (a * b) >>> 0;
}

export function makeRng(seed) {
  let a = hash32(String(seed)) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = imul(t ^ (t >>> 15), t | 1);
    t ^= t + imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

export function dateSeed(offsetDays = 0) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { key, epochDays: Math.floor(d.getTime() / 86400000) };
}
