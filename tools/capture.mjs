/* Test convention: the app always synthesises and matches at MEOW_MATCH.SR0.
   A 44.1/48 kHz *recording* of the same sound is modelled by resampling the
   canonical audio up to the capture rate before analysis.

   The resampler matters: an earlier version used linear interpolation, which
   sprays imaging artefacts and made 48 kHz look far worse than it is. This is a
   windowed-sinc interpolator with an anti-alias low-pass on the way down. */
export function resampleSinc(x, srIn, srOut) {
  if (srIn === srOut) return x;
  const ratio = srOut / srIn;
  const outLen = Math.max(1, Math.floor(x.length * ratio));
  const y = new Float32Array(outLen);
  const TAPS = 24;
  const fc = 0.5 * Math.min(1, ratio) * 0.94;      // cutoff in output cycles/sample
  const norm = 2 * fc;
  for (let i = 0; i < outLen; i++) {
    const p = i / ratio;                            // position in input samples
    const i0 = Math.floor(p), frac = p - i0;
    let acc = 0, wsum = 0;
    const lo = Math.max(-TAPS + 1, -i0), hi = Math.min(TAPS, x.length - 1 - i0);
    for (let k = lo; k <= hi; k++) {
      const d = frac - k;                           // distance in input samples
      if (Math.abs(d) > TAPS) continue;
      const z = Math.PI * norm * d;
      const sinc = z === 0 ? 1 : Math.sin(z) / z;
      const w = 0.5 - 0.5 * Math.cos(Math.PI * (d / TAPS + 1));   // Hann over the tap span
      const g = sinc * w;
      acc += (x[i0 + k] || 0) * g; wsum += g;
    }
    y[i] = wsum !== 0 ? acc / wsum : 0;
  }
  return y;
}

export function captureAt(audio22050, sr) {
  return resampleSinc(audio22050, 22050, sr);
}
