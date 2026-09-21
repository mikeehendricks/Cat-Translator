import sys, wave, numpy as np

def load(p):
    w = wave.open(p,'rb'); sr=w.getframerate(); n=w.getnframes()
    d = np.frombuffer(w.readframes(n), dtype='<i2').astype(np.float64)/32768
    return d, sr

def f0_track(x, sr, fmin=150, fmax=1500, win=1024, hop=256):
    lo, hi = int(sr/fmax), int(sr/fmin)
    out=[]
    for s in range(0, max(1,len(x)-win), hop):
        fr = x[s:s+win]
        if np.sqrt(np.mean(fr**2)) < 0.02: out.append(np.nan); continue
        fr = fr*np.hanning(len(fr)); ac = np.correlate(fr,fr,'full')[len(fr)-1:]
        ac /= (ac[0]+1e-12)
        seg = ac[lo:hi]
        if len(seg)==0: out.append(np.nan); continue
        k = int(np.argmax(seg))+lo
        out.append(sr/k if ac[k]>0.3 else np.nan)
    return np.array(out)

def env(x, sr, hop=256):
    return np.array([np.sqrt(np.mean(x[s:s+hop]**2)) for s in range(0,len(x)-hop,hop)])

def describe(p, label):
    x, sr = load(p)
    e = env(x, sr); f = f0_track(x, sr)
    dur = len(x)/sr
    print(f"{label:26s} dur={dur:5.2f}s peak={np.abs(x).max():.2f} rms={np.sqrt(np.mean(x**2)):.3f}")
    # voiced span + pitch trend
    v = ~np.isnan(f)
    if v.sum() > 2:
        fv = f[v]; t = np.where(v)[0]*256/sr
        st = 12*np.log2(fv/np.median(fv))
        print(f"   voiced {v.sum()} frames  f0 {np.nanmin(f):.0f}-{np.nanmax(f):.0f}Hz (med {np.median(fv):.0f})  contour(st rel med): " +
              " ".join(f"{q:+.1f}" for q in np.interp(np.linspace(0,1,7), np.linspace(0,1,len(st)), st)))
    # spectrum peaks
    S = np.abs(np.fft.rfft(x*np.hanning(len(x))))
    fr = np.fft.rfftfreq(len(x), 1/sr)
    band = (fr>200)&(fr<6000)
    pk = sorted([(S[i], fr[i]) for i in np.argsort(S[band])[-400:] if S[i]>0], reverse=True)[:1]
    sm = np.convolve(S[band], np.ones(31)/31, 'same')
    loc = [fr[band][i] for i in range(2,len(sm)-2) if sm[i]==max(sm[max(0,i-40):i+40]) and sm[i]>0.15*sm.max()]
    print(f"   spectral peaks: {[int(l) for l in loc[:6]]} Hz")
    # 15-35 Hz modulation (purr detector)
    if len(e) > 12:
        ee = e - e.mean()
        mag = np.abs(np.fft.rfft(ee*np.hanning(len(ee))))
        mf = np.fft.rfftfreq(len(ee), 256/sr)
        band = (mf>15)&(mf<40)
        print(f"   purr band 15-40Hz: {mag[band].max()/(len(ee)*e.mean()+1e-9)*100:.1f}%")

for p, l in [(a.split('=')[0], a.split('=')[1]) for a in sys.argv[1:]]:
    describe(p, l)
