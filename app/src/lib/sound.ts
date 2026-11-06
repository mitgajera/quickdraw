// Tiny WebAudio synth for game feedback — no audio files. Browsers only allow audio after a user
// gesture, and every sound here follows one (a tap) or a tap's result.
let ctx: AudioContext | null = null;
let on = true;
try { on = localStorage.getItem("qd-sound") !== "off"; } catch { /* private mode */ }

function audio(): AudioContext | null {
  if (!on || typeof window === "undefined") return null;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freq: number, endFreq: number, start: number, dur: number, gain: number, type: OscillatorType = "sine") {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sound = {
  get enabled() { return on; },
  set enabled(v: boolean) {
    on = v;
    try { localStorage.setItem("qd-sound", v ? "on" : "off"); } catch { /* private mode */ }
  },
  tap() { tone(1400, 700, 0, 0.05, 0.07, "triangle"); },
  confirm() { tone(1800, 1800, 0, 0.03, 0.03); },
  win() {
    [1046.5, 1318.5, 1568, 2093].forEach((f, i) => tone(f, f, i * 0.07, 0.16, 0.08));
  },
  lose() { tone(240, 140, 0, 0.18, 0.05, "triangle"); },
};
