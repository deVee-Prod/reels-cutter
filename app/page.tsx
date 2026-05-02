"use client";

import React, { useState, useRef, useEffect } from 'react';
import Image from 'next/image';

function LabelFooter() {
  return (
    <footer className="w-full py-12 flex flex-col items-center space-y-4 mt-auto">
      <p className="text-[10px] tracking-[0.2em] font-medium text-white/60">Powered By deVee Boutique Label</p>
      <div className="w-12 h-12 rounded-full overflow-hidden">
        <Image src="/label_logo.jpg" alt="deVee Label" width={48} height={48} className="object-cover" />
      </div>
    </footer>
  );
}


function remapToExportTime(
  t: number,
  segs: { start: number; end: number | null }[],
  dur: number
): number {
  let offset = 0;
  for (const seg of segs) {
    const segEnd = seg.end ?? dur;
    if (t <= seg.start) return offset;
    if (t < segEnd) return offset + (t - seg.start);
    offset += segEnd - seg.start;
  }
  return offset;
}

export default function ReelsCutterPage() {
  const [authStatus, setAuthStatus] = useState<'checking' | 'ok'>('checking');
  const [authorized, setAuthorized] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [segments, setSegments] = useState<{ start: number; end: number | null }[] | null>(null);
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [paused, setPaused] = useState(true);
  const [zoom, setZoom] = useState(4);
  const [subtitleWords, setSubtitleWords] = useState<{ word: string; start: number; end: number }[]>([]);
  const [subtitleMode, setSubtitleMode] = useState(false);
  const [subtitleAlwaysShow, setSubtitleAlwaysShow] = useState(false);
  const [subtitlePos, setSubtitlePos] = useState(25);
  const [fontScale, setFontScale] = useState(1);

  const ffmpegRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const wordCardsRef = useRef<HTMLDivElement>(null);
  const lastActiveWordIdxRef = useRef(-1);
  const draggingRef = useRef<{ index: number; edge: 'start' | 'end' } | null>(null);
  const rafRef = useRef<number | null>(null);
  const segmentsRef = useRef<{ start: number; end: number | null }[] | null>(null);
  const durationRef = useRef<number>(0);
  const programmaticSeekRef = useRef(false);
  const warmingUpRef = useRef(false);
  const prefetchVideoRef = useRef<HTMLVideoElement>(null);
  const prefetchWarmedRef = useRef(false);
  const lastSegIdxRef = useRef(-1);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const seekDraggingRef = useRef(false);

  useEffect(() => {
    import('./supabaseClient').then(({ supabase }) => {
      supabase.auth.refreshSession().then(({ data, error }: { data: { session: unknown }, error: unknown }) => {
        if (data.session && !error) {
          setAuthStatus('ok');
        } else {
          window.location.href = 'https://devee-music.com';
        }
      });
    });
  }, []);

  useEffect(() => {
    if (document.cookie.includes('session_access=granted')) {
      setAuthorized(true);
      loadFFmpeg();
    }
  }, []);

  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);
  useEffect(() => { if (window.innerWidth < 768) setZoom(8); }, []);

  useEffect(() => {
    const c = timelineContainerRef.current;
    if (!c || zoom <= 1 || !duration) return;
    const cw = c.clientWidth;
    const ph = (currentTime / duration) * cw * zoom;
    if (ph < c.scrollLeft + 40 || ph > c.scrollLeft + cw - 40)
      c.scrollLeft = Math.max(0, ph - cw * 0.25);
  }, [currentTime, zoom, duration]);

  // auto-scroll word cards to follow active word
  useEffect(() => {
    const container = wordCardsRef.current;
    if (!container || !segments || !subtitleMode) return;
    const rct = remapToExportTime(currentTime, segments, duration);
    const activeIdx = subtitleWords.findIndex(w => {
      const rs = remapToExportTime(w.start, segments, duration);
      const re = Math.max(rs + 0.08, remapToExportTime(w.end, segments, duration));
      return rct >= rs && rct <= re;
    });
    if (activeIdx < 0 || activeIdx === lastActiveWordIdxRef.current) return;
    lastActiveWordIdxRef.current = activeIdx;
    const card = container.children[activeIdx] as HTMLElement;
    if (!card) return;
    container.scrollLeft = Math.max(0, card.offsetLeft - container.clientWidth / 2 + card.offsetWidth / 2);
  }, [currentTime, segments, subtitleWords, duration, subtitleMode]);

  const stopLoop = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const startLoop = () => {
    stopLoop();
    const tick = () => {
      const v = videoRef.current;
      const segs = segmentsRef.current;
      const dur = durationRef.current;
      if (!v || !segs || v.paused || draggingRef.current || seekDraggingRef.current || warmingUpRef.current) { rafRef.current = null; return; }
      const t = v.currentTime;
      const inSeg = segs.find(s => t >= s.start && t <= (s.end ?? dur));

      const jumpTo = (target: number) => {
        programmaticSeekRef.current = true;
        v.muted = true;
        v.currentTime = target;
        const fallback = setTimeout(() => { if (videoRef.current) { videoRef.current.muted = false; startLoop(); } }, 800);
        v.addEventListener('seeked', () => { clearTimeout(fallback); if (videoRef.current) { videoRef.current.muted = false; startLoop(); } }, { once: true });
      };

      if (!inSeg) {
        const next = segs.filter(s => s.start > t).sort((a, b) => a.start - b.start)[0];
        if (next) jumpTo(next.start); else v.pause();
        rafRef.current = null; return;
      }

      const idx = segs.indexOf(inSeg);
      if (idx !== lastSegIdxRef.current) { lastSegIdxRef.current = idx; prefetchWarmedRef.current = false; }
      if (inSeg.end !== null && t >= inSeg.end - 1.5 && !prefetchWarmedRef.current) {
        const nextSeg = segs[idx + 1];
        const pv = prefetchVideoRef.current;
        if (nextSeg && pv) {
          prefetchWarmedRef.current = true;
          pv.currentTime = nextSeg.start;
          pv.play().catch(() => {});
          setTimeout(() => { if (prefetchVideoRef.current) prefetchVideoRef.current.pause(); }, 500);
        }
      }

      if (inSeg.end !== null && t >= inSeg.end - 0.2) {
        const nextSeg = segs[idx + 1];
        if (nextSeg) jumpTo(nextSeg.start); else v.pause();
        rafRef.current = null; return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const handlePointerUp = () => {
      if (draggingRef.current) {
        draggingRef.current = null;
        if (videoRef.current && !videoRef.current.paused) startLoop();
      }
    };
    window.addEventListener('pointerup', handlePointerUp);
    return () => window.removeEventListener('pointerup', handlePointerUp);
  }, []);

  const handleTimeUpdate = () => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
  };

  const loadFFmpeg = async () => {
    if (ffmpegRef.current) return;
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const ffmpeg = new FFmpeg();
    ffmpegRef.current = ffmpeg;
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    ffmpeg.on('progress', ({ progress }) => setProgress(Math.round(progress * 100)));
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    setLoaded(true);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (res.ok) { setAuthorized(true); loadFFmpeg(); } else { setLoginError(true); setPassword(''); setTimeout(() => setLoginError(false), 2000); }
    setLoginLoading(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      setSegments(null);
      setSubtitleWords([]);
      setSubtitleMode(false);
      setSubtitleAlwaysShow(false);
      setProgress(0);
      setStatus("Ready");
    }
  };

  const warmupSegments = async (segs: { start: number; end: number | null }[]) => {
    const video = videoRef.current;
    if (!video || segs.length === 0) return;
    const globalDeadline = Date.now() + 25000;
    if (video.readyState < 2) {
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, 3000);
        video.addEventListener('loadeddata', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
    warmingUpRef.current = true;
    video.muted = true;
    const seekTo = (t: number) => new Promise<void>(resolve => {
      if (Date.now() >= globalDeadline) { resolve(); return; }
      const fallback = setTimeout(resolve, 500);
      video.addEventListener('seeked', () => { clearTimeout(fallback); resolve(); }, { once: true });
      video.currentTime = t;
    });
    for (const seg of segs) {
      if (Date.now() >= globalDeadline) break;
      await seekTo(seg.start);
      await video.play().catch(() => {});
      await new Promise<void>(r => setTimeout(r, 700));
      video.pause();
    }
    video.muted = false;
    warmingUpRef.current = false;
    video.currentTime = segs[0].start;
  };

  const analyzeVideo = async () => {
    if (!videoFile || !loaded) return;
    setProcessing(true);
    const ffmpeg = ffmpegRef.current;
    const { fetchFile } = await import('@ffmpeg/util');
    try {
      setStatus("Extracting audio...");
      setProgress(0);
      await ffmpeg.writeFile('input.mov', await fetchFile(videoFile));
      await ffmpeg.exec(['-i', 'input.mov', '-vn', '-ar', '16000', '-ac', '1', 'whisper.mp3']);
      const audioData = await ffmpeg.readFile('whisper.mp3');
      const audioBlob = new Blob([(audioData as any).buffer], { type: 'audio/mpeg' });
      const form = new FormData();
      form.append('video', audioBlob, 'audio.mp3');
      const whisperPromise = fetch('/api/whisper', { method: 'POST', body: form });
      setStatus("Creating preview...");
      await ffmpeg.exec(['-i', 'input.mov', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '15', '-keyint_min', '15', '-c:a', 'copy', 'preview.mp4']);
      const previewData = await ffmpeg.readFile('preview.mp4');
      setVideoUrl(URL.createObjectURL(new Blob([(previewData as any).buffer], { type: 'video/mp4' })));
      setStatus("Whisper is analyzing...");
      const res = await whisperPromise;
      const data = await res.json();
      if (data.segments) {
        setSegments(data.segments);
        if (data.words) setSubtitleWords(data.words);
        setStatus("Preparing edit...");
        setProgress(0);
        await warmupSegments(data.segments);
        setStatus("Review Edit");
      }
    } catch (e) {
      setStatus("Error");
    } finally {
      setProcessing(false);
    }
  };

  const renderVideo = async () => {
    if (!videoFile || !segments) return;
    setProcessing(true);
    setProgress(0);
    setStatus("Rendering 1080p Master...");
    try {
      const { fetchFile } = await import('@ffmpeg/util');
      await ffmpegRef.current.writeFile('input.mov', await fetchFile(videoFile));

      const withSubtitles = (subtitleMode || subtitleAlwaysShow) && subtitleWords.length > 0;

      if (withSubtitles) {
        setStatus("Loading font...");
        const fontRes = await fetch('/NotoSansTight.ttf');
        if (!fontRes.ok) throw new Error('NotoSansTight.ttf not found in /public');
        await ffmpegRef.current.writeFile('myfont.ttf', new Uint8Array(await fontRes.arrayBuffer()));
        setStatus("Rendering 1080p Master...");
      }

      const exportScale = 1080 / 200;

      let f = '', c = '';
      segments.forEach((s, i) => {
        const e = s.end ?? duration;
        f += `[0:v]trim=start=${s.start}:end=${e},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=start=${s.start}:end=${e},asetpts=PTS-STARTPTS[a${i}];`;
        c += `[v${i}][a${i}]`;
      });

      let drawtextChain = '';
      if (withSubtitles) {
        const dtFilters = subtitleWords.map((w, i) => {
          const safeWord = w.word.trim()
            .toUpperCase()
            .replace(/'/g, '')
            .replace(/:/g, '\\:')
            .replace(/,/g, '\\,')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]');
          if (!safeWord) return null;
          const fontSize = Math.round([14, 20, 28][i % 3] * exportScale * fontScale);
          const rs = remapToExportTime(w.start, segments, duration);
          const re = Math.max(rs + 0.08, remapToExportTime(w.end, segments, duration));
          const yPos = `h-(h*${subtitlePos}/100)-text_h`;
          return `drawtext=fontfile='myfont.ttf':text='${safeWord}':enable='between(t,${rs.toFixed(3)},${re.toFixed(3)})':x=(w-text_w)/2:y=${yPos}:fontsize=${fontSize}:fontcolor=0xECE9E4:bordercolor=black@0.9:borderw=2:shadowx=0:shadowy=2:shadowcolor=black@0.95:box=1:boxcolor=black@0.18:boxborderw=14`;
        }).filter(Boolean);
        if (dtFilters.length > 0) drawtextChain = dtFilters.join(',') + ',';
      }

      f += `${c}concat=n=${segments.length}:v=1:a=1[vraw][outa];[vraw]${drawtextChain}fps=30,scale=1080:-2[outv]`;

      await ffmpegRef.current.exec(['-i', 'input.mov', '-filter_complex', f, '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', 'out.mp4']);
      if (withSubtitles) await ffmpegRef.current.deleteFile('myfont.ttf').catch(() => {});

      const url = URL.createObjectURL(new Blob([(await ffmpegRef.current.readFile('out.mp4') as any).buffer], { type: 'video/mp4' }));
      const a = document.createElement('a'); a.href = url; a.download = `deVee_${videoFile.name}.mp4`; a.click();
    } catch (e) { setStatus("Error"); } finally { setProcessing(false); }
  };

  if (authStatus === 'checking') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem' }}>
        <p style={{ color: '#fff', fontSize: '1.125rem', fontFamily: 'sans-serif' }}>
          Verifying Access to deVee Tools...
        </p>
        <a href="https://devee-music.com" style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem', fontFamily: 'sans-serif', textDecoration: 'none', letterSpacing: '0.05em' }}>
          ← Back to deVee Music
        </a>
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="min-h-[100dvh] bg-[#050505] flex flex-col items-center text-center">
        <header className="space-y-2 pt-8 pb-6 relative">
          <div className="absolute top-6 left-1/2 -translate-x-1/2 w-56 h-20 bg-[#D4AF37] blur-[55px] opacity-[0.14] pointer-events-none" />
          <Image src="/logo.png" alt="Logo" width={100} height={32} className="mx-auto opacity-90 relative" />
          <p className="text-[9px] tracking-[0.3em] text-white/70 font-bold uppercase">REELS CUTTER</p>
        </header>
        <main className="flex-1 flex flex-col justify-center w-full max-w-[340px] px-4">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <div className="flex items-center gap-2">
              <div className="h-px w-8 bg-[#D4AF37]/30" />
              <span className="text-[#D4AF37] text-[9px] tracking-[0.35em] uppercase font-semibold">1080p Vertical Video</span>
              <div className="h-px w-8 bg-[#D4AF37]/30" />
            </div>
            <p dir="rtl" className="text-white text-[11px] tracking-[0.05em] font-light">מיועד לסרטוני וידאו אנכי <span dir="ltr">1080p</span></p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4 bg-[#0c0c0c]/40 p-8 rounded-[24px] border border-white/5 backdrop-blur-xl w-full">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3 px-4 text-white text-center tracking-[0.4em] text-[9px] focus:outline-none" placeholder="ACCESS KEY" />
            <button type="submit" className="w-full py-3 bg-[#D4AF37] text-black rounded-xl uppercase tracking-[0.3em] text-[8px] font-black">Enter</button>
          </form>
        </main>
        <LabelFooter />
      </div>
    );
  }

  const remappedCurrentTime = segments ? remapToExportTime(currentTime, segments, duration) : currentTime;
  const showSubtitleOverlay = (subtitleMode || subtitleAlwaysShow) && subtitleWords.length > 0 && !!segments;

  return (
    <div className="min-h-[100dvh] bg-[#050505] text-white flex flex-col items-center overflow-y-auto overflow-x-hidden font-sans">
      <header className="text-center space-y-2 pt-8 pb-6 relative">
        <div className="absolute -top-6 left-1/2 -translate-x-1/2 w-56 h-20 bg-[#D4AF37] blur-[55px] opacity-[0.14] pointer-events-none" />
        <Image src="/logo.png" alt="Logo" width={80} height={26} className="opacity-90 mx-auto relative" />
        <p className="text-[9px] tracking-[0.3em] text-white/70 font-bold uppercase">REELS CUTTER</p>
      </header>

      <main className="w-full max-w-[550px] mx-auto flex flex-col items-center flex-1 justify-center px-2 md:px-6 gap-4 py-6">
        <div className="w-full bg-[#0c0c0c] border border-white/[0.05] rounded-[40px] p-4 md:p-6 relative group shadow-2xl">
          <div className="relative flex flex-col items-center gap-4">
            {videoUrl ? (
              <div className="w-full flex flex-col items-center">

                {/* ── Video preview ── */}
                <div className="relative w-[200px] bg-black rounded-[30px] overflow-hidden border border-white/10 mb-2 shadow-inner flex-shrink-0" style={{ height: '356px' }}>
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                    onTimeUpdate={handleTimeUpdate}
                    onPlay={() => { if (!warmingUpRef.current) setPaused(false); startLoop(); }}
                    onSeeked={(e) => {
                      if (programmaticSeekRef.current) { programmaticSeekRef.current = false; return; }
                      if (!e.currentTarget.paused && !draggingRef.current && !seekDraggingRef.current) startLoop();
                    }}
                    onPause={() => { stopLoop(); if (!warmingUpRef.current) setPaused(true); }}
                    className="w-full h-full object-cover"
                    playsInline
                    onClick={() => videoRef.current?.paused ? videoRef.current.play() : videoRef.current?.pause()}
                  />
                  <video ref={prefetchVideoRef} src={videoUrl ?? undefined} muted playsInline className="absolute w-0 h-0 opacity-0 pointer-events-none" />

                  {/* Subtitle overlay — visible in both CC mode and when subtitleAlwaysShow is on */}
                  {showSubtitleOverlay && (() => {
                    const wordObj = subtitleWords.find(w => {
                      const rs = remapToExportTime(w.start, segments!, duration);
                      const re = Math.max(rs + 0.08, remapToExportTime(w.end, segments!, duration));
                      return remappedCurrentTime >= rs && remappedCurrentTime <= re;
                    });
                    if (!wordObj) return null;
                    const idx = subtitleWords.indexOf(wordObj);
                    const fontSize = [14, 20, 28][idx % 3] * fontScale;
                    return (
                      <div className="absolute left-0 right-0 flex justify-center px-2 pointer-events-none z-10" style={{ bottom: `${subtitlePos}%` }}>
                        <span className="uppercase leading-none" style={{ fontSize: `${fontSize}px`, fontWeight: 900, letterSpacing: '-0.04em', color: '#ffffff', textShadow: '0 1px 6px rgba(0,0,0,1), 0 0 12px rgba(0,0,0,0.9)', WebkitFontSmoothing: 'antialiased' } as React.CSSProperties}>
                          {wordObj.word}
                        </span>
                      </div>
                    );
                  })()}

                  {processing && (
                    <div className="absolute inset-0 bg-black/70 backdrop-blur-md flex flex-col items-center justify-center p-4 text-center gap-3">
                      <span className="text-[#D4AF37] text-[10px] uppercase tracking-widest animate-pulse font-bold">{status}</span>
                      {progress > 0 && (
                        <div className="w-[140px] flex flex-col items-center gap-1">
                          <div className="w-full h-[2px] bg-white/10 rounded-full overflow-hidden">
                            <div className="h-full bg-[#D4AF37] rounded-full transition-all duration-200" style={{ width: `${progress}%` }} />
                          </div>
                          <span className="text-white/40 text-[8px] tracking-widest">{progress}%</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {segments && (
                  <div className="flex flex-col items-center gap-1 mt-2 mb-2">
                    <p className="text-white/60 text-[8px] tracking-[0.12em] font-light">Don&apos;t worry about the quality — it&apos;s just a preview</p>
                    <p dir="rtl" className="text-white/60 text-[8px] tracking-[0.05em] font-light">לא לדאוג מהאיכות זה רק תצוגה מקדימה</p>
                  </div>
                )}

                {/* ── Bottom panel — CUTTER MODE / SUBTITLE MODE ── */}
                {segments && (
                  <div className="w-full mb-6 space-y-2">

                    {!subtitleMode ? (
                      <>
                        {/* ── CUTTER MODE ── */}
                        <div className="flex items-center justify-between px-0.5">
                          <span className="text-white/25 text-[7px] uppercase tracking-[0.2em]">Edit</span>
                          <div className="flex items-center gap-2">
                            <button onClick={() => { setZoom(z => Math.max(1, z / 2)); if (zoom <= 2 && timelineContainerRef.current) timelineContainerRef.current.scrollLeft = 0; }} className="w-7 h-7 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] rounded-lg text-white/50 text-sm transition-colors">−</button>
                            <span className="text-white/30 text-[9px] w-5 text-center">{zoom}×</span>
                            <button onClick={() => setZoom(z => Math.min(16, z * 2))} className="w-7 h-7 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] rounded-lg text-white/50 text-sm transition-colors">+</button>
                          </div>
                        </div>

                        <div ref={timelineContainerRef} className="w-full overflow-x-auto rounded-xl" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
                          <div className="relative h-8" style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
                            {segments.map((seg, i) => (
                              <button key={`del-${i}`} className="absolute top-1 -translate-x-1/2 flex items-center justify-center w-6 h-6 text-red-500 hover:text-red-400 text-[14px] font-black leading-none z-20 transition-colors" style={{ left: `${(((seg.start + (seg.end ?? duration)) / 2) / duration) * 100}%` }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setSegments(prev => prev ? prev.filter((_, idx) => idx !== i) : prev); }}>×</button>
                            ))}
                          </div>
                          <div ref={timelineRef} className="relative h-20 md:h-14 bg-white/[0.03] border border-white/10 rounded-xl" style={{ width: `${zoom * 100}%`, minWidth: '100%', touchAction: zoom > 1 ? 'pan-x' : 'none' }}>
                            {segments.map((seg, i) => (
                              <div key={i} className="absolute top-0 bottom-0 cursor-ew-resize" style={{ left: `${(seg.start / duration) * 100}%`, width: `${(((seg.end ?? duration) - seg.start) / duration) * 100}%`, touchAction: 'none' }}
                                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); const rect = e.currentTarget.getBoundingClientRect(); draggingRef.current = { index: i, edge: (e.clientX - rect.left) < rect.width / 2 ? 'start' : 'end' }; }}
                                onPointerMove={(e) => { if (!draggingRef.current || !timelineRef.current) return; const rect = timelineRef.current.getBoundingClientRect(); const t = Math.max(0, Math.min(e.clientX - rect.left, rect.width)) / rect.width * duration; const { edge } = draggingRef.current; setSegments(prev => prev ? prev.map((s, idx) => { if (idx !== i) return s; if (edge === 'start') return { ...s, start: Math.min(t, (s.end ?? duration) - 0.1) }; return { ...s, end: Math.max(t, s.start + 0.1) }; }) : prev); }}
                                onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); const dragIdx = draggingRef.current?.index ?? i; draggingRef.current = null; const seg = segmentsRef.current?.[dragIdx]; if (videoRef.current && seg) videoRef.current.currentTime = seg.start; if (videoRef.current && !videoRef.current.paused) startLoop(); }}
                              >
                                <div className="absolute left-0 top-0 h-full w-2 bg-[#D4AF37] rounded-l-sm pointer-events-none" />
                                <div className="absolute left-2 right-2 top-0 bottom-0 bg-[#D4AF37]/30 pointer-events-none" />
                                <div className="absolute right-0 top-0 h-full w-2 bg-[#D4AF37] rounded-r-sm pointer-events-none" />
                              </div>
                            ))}
                            <div className="absolute top-0 bottom-0 w-[2px] bg-white/70 pointer-events-none" style={{ left: `${(currentTime / duration) * 100}%` }} />
                          </div>
                        </div>

                        <div ref={seekBarRef} className="relative w-full h-10 md:h-6 flex items-center cursor-pointer" style={{ touchAction: 'none' }} onClick={(e) => { if (!seekBarRef.current || !videoRef.current) return; const rect = seekBarRef.current.getBoundingClientRect(); videoRef.current.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}>
                          <div className="relative w-full h-[3px] bg-white/[0.08] rounded-full pointer-events-none">
                            <div className="absolute left-0 top-0 h-full bg-[#D4AF37]/50 rounded-full" style={{ width: `${(currentTime / duration) * 100}%` }} />
                          </div>
                          <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 md:w-3 md:h-3 rounded-full bg-[#D4AF37] shadow-[0_0_8px_rgba(212,175,55,0.45)] cursor-grab active:cursor-grabbing pointer-events-auto" style={{ left: `${(currentTime / duration) * 100}%` }}
                            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); seekDraggingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
                            onPointerMove={(e) => { if (!seekDraggingRef.current || !seekBarRef.current || !videoRef.current) return; const rect = seekBarRef.current.getBoundingClientRect(); videoRef.current.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}
                            onPointerUp={(e) => { seekDraggingRef.current = false; e.currentTarget.releasePointerCapture(e.pointerId); if (videoRef.current && !videoRef.current.paused) startLoop(); }}
                          />
                        </div>

                        <div className="flex justify-center items-center gap-3">
                          <button onClick={() => { const v = videoRef.current; const segs = segmentsRef.current; if (!v) return; v.pause(); v.currentTime = segs?.[0]?.start ?? 0; setPaused(true); }} className="w-9 h-9 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg transition-colors">
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="2" height="10" rx="1" fill="currentColor" className="text-white/60" /><path d="M13 2.5L5 7l8 4.5V2.5Z" fill="currentColor" className="text-white/60" /></svg>
                          </button>
                          <button onClick={() => paused ? videoRef.current?.play() : videoRef.current?.pause()} className="px-6 py-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg text-[9px] uppercase tracking-widest transition-colors">{paused ? 'Play' : 'Pause'}</button>
                        </div>

                        {subtitleWords.length > 0 && (
                          <div className="flex justify-center items-center gap-3">
                            <button onClick={() => setSubtitleMode(true)} className="px-5 py-1.5 text-[8px] uppercase tracking-widest rounded-lg border bg-white/[0.04] border-white/[0.07] text-white/30 hover:text-white/50 transition-colors">CC</button>
                            <button onClick={() => setSubtitleAlwaysShow(p => !p)} className={`px-5 py-1.5 text-[8px] uppercase tracking-widest rounded-lg border transition-colors ${subtitleAlwaysShow ? 'bg-white/[0.12] border-white/40 text-white/80' : 'bg-white/[0.04] border-white/[0.07] text-white/30 hover:text-white/50'}`}>CC Visible</button>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        {/* ── SUBTITLE MODE ── */}

                        {/* Seek bar */}
                        <div className="relative w-full h-10 md:h-6 flex items-center cursor-pointer" style={{ touchAction: 'none' }}
                          onClick={(e) => { if (!videoRef.current) return; const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); videoRef.current.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}
                        >
                          <div className="relative w-full h-[3px] bg-white/[0.08] rounded-full pointer-events-none">
                            <div className="absolute left-0 top-0 h-full bg-[#D4AF37]/50 rounded-full" style={{ width: `${(currentTime / duration) * 100}%` }} />
                          </div>
                          <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 md:w-3 md:h-3 rounded-full bg-[#D4AF37] shadow-[0_0_8px_rgba(212,175,55,0.45)] cursor-grab active:cursor-grabbing pointer-events-auto" style={{ left: `${(currentTime / duration) * 100}%` }}
                            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); seekDraggingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
                            onPointerMove={(e) => { if (!seekDraggingRef.current || !videoRef.current) return; const rect = (e.currentTarget.parentElement as HTMLDivElement).getBoundingClientRect(); videoRef.current.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}
                            onPointerUp={(e) => { seekDraggingRef.current = false; e.currentTarget.releasePointerCapture(e.pointerId); if (videoRef.current && !videoRef.current.paused) startLoop(); }}
                          />
                        </div>

                        {/* Play controls */}
                        <div className="flex justify-center items-center gap-3">
                          <button onClick={() => { const v = videoRef.current; const segs = segmentsRef.current; if (!v) return; v.pause(); v.currentTime = segs?.[0]?.start ?? 0; setPaused(true); }} className="w-9 h-9 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg transition-colors">
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="2" height="10" rx="1" fill="currentColor" className="text-white/60" /><path d="M13 2.5L5 7l8 4.5V2.5Z" fill="currentColor" className="text-white/60" /></svg>
                          </button>
                          <button onClick={() => paused ? videoRef.current?.play() : videoRef.current?.pause()} className="px-6 py-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg text-[9px] uppercase tracking-widest transition-colors">{paused ? 'Play' : 'Pause'}</button>
                        </div>

                        {/* Word cards — auto-scrolls to active word */}
                        <div ref={wordCardsRef} className="w-full h-24 bg-white/[0.02] border border-white/[0.05] rounded-xl p-2 flex gap-1.5 items-center overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch', scrollBehavior: 'smooth' } as React.CSSProperties}>
                          {subtitleWords.map((w, i) => {
                            const isCut = !segments.some(s => w.start < (s.end ?? duration) && w.end > s.start);
                            const rs = remapToExportTime(w.start, segments, duration);
                            const re = Math.max(rs + 0.08, remapToExportTime(w.end, segments, duration));
                            const isActive = remappedCurrentTime >= rs && remappedCurrentTime <= re;
                            return (
                              <div key={i} className={`h-full min-w-[46px] border rounded-xl flex flex-col items-center justify-center p-1 relative flex-shrink-0 transition-all ${isActive ? 'bg-[#D4AF37]/20 border-[#D4AF37]/60' : isCut ? 'bg-white/[0.01] border-white/[0.04] opacity-35' : 'bg-white/[0.02] border-white/[0.06]'}`}>
                                <input value={w.word} onChange={(e) => { const updated = [...subtitleWords]; updated[i] = { ...updated[i], word: e.target.value }; setSubtitleWords(updated); }} className="bg-transparent border-none outline-none text-[8px] text-white font-bold text-center w-full" />
                                <button onClick={() => setSubtitleWords(prev => prev.filter((_, idx) => idx !== i))} className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-500/40 rounded-full text-[6px] flex items-center justify-center hover:bg-red-500/70 transition-colors">×</button>
                              </div>
                            );
                          })}
                        </div>

                        {/* Bottom row: ← back | size | pos | ✓ show in cut */}
                        <div className="flex items-center justify-between px-0.5 gap-2">
                          <button onClick={() => setSubtitleMode(false)} className="w-7 h-7 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] rounded-lg text-white/50 text-sm transition-colors flex-shrink-0">←</button>
                          <div className="flex items-center gap-1.5">
                            <span className="text-white/25 text-[7px] uppercase tracking-[0.2em]">Size</span>
                            <input type="range" min="0.5" max="2" step="0.1" value={fontScale} onChange={e => setFontScale(parseFloat(e.target.value))} className="w-16 accent-[#D4AF37]" />
                          </div>
                          <div className="flex items-center gap-1">
                            <button onClick={() => setSubtitlePos(p => Math.min(90, p + 5))} className="w-7 h-7 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] rounded-lg text-white/50 text-sm transition-colors">↑</button>
                            <button onClick={() => setSubtitlePos(p => Math.max(5, p - 5))} className="w-7 h-7 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] rounded-lg text-white/50 text-sm transition-colors">↓</button>
                          </div>
                          {/* Show subtitles in cut mode toggle */}
                          <button onClick={() => setSubtitleAlwaysShow(p => !p)} className={`px-5 py-1.5 text-[8px] uppercase tracking-widest rounded-lg border transition-colors ${subtitleAlwaysShow ? 'bg-white/[0.12] border-white/40 text-white/80' : 'bg-white/[0.04] border-white/[0.07] text-white/30 hover:text-white/50'}`}>CC Visible</button>
                        </div>
                      </>
                    )}

                  </div>
                )}
              </div>
            ) : (
              <label className="w-full cursor-pointer">
                <div className="w-full bg-[#080808] rounded-[28px] flex flex-col items-center justify-center py-24 md:py-32">
                  <div className="w-14 h-14 rounded-full border border-white/20 flex items-center justify-center mb-5">
                    <span className="text-white/35 text-2xl leading-none font-thin select-none">+</span>
                  </div>
                  <span className="text-[8px] uppercase tracking-[0.55em] text-white/25">Upload Media</span>
                </div>
                <input type="file" className="hidden" onChange={handleFileUpload} accept="video/*" />
              </label>
            )}

            {!segments && !videoFile && (
              <button disabled className="w-full py-5 rounded-[22px] uppercase tracking-[0.4em] text-[10px] font-black cursor-default" style={{ backgroundColor: '#0e0e0e', color: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.04)' }}>Cut Video</button>
            )}
            {!segments && videoFile && (
              <button onClick={analyzeVideo} disabled={processing} className="w-full py-5 rounded-[22px] uppercase tracking-[0.4em] text-[10px] font-black bg-[#D4AF37] text-black transition-transform duration-200 hover:scale-[1.025] active:scale-[0.97]">{processing ? "Analysing..." : "Cut Video"}</button>
            )}
            {segments && (
              <button onClick={renderVideo} disabled={processing} className="w-full py-5 rounded-[22px] bg-[#D4AF37] text-black uppercase tracking-[0.4em] text-[10px] font-black transition-transform duration-200 hover:scale-[1.025] active:scale-[0.97]">Export Master</button>
            )}
          </div>
        </div>
      </main>
      <LabelFooter />
    </div>
  );
}
