"use client";

import React, { useState, useRef, useEffect } from 'react';
import Image from 'next/image';

function LabelFooter() {
  return (
    <div className="w-full mb-4 md:mb-8 flex flex-col items-center gap-4">
      <p className="text-[7px] tracking-[0.15em] font-light text-white/50 uppercase">
        Powered By deVee Boutique Label
      </p>
      <Image src="/label_logo.jpg" alt="deVee Label" width={48} height={48} className="rounded-full opacity-100 shadow-xl" />
    </div>
  );
}

export default function ReelsCutterPage() {
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

  const ffmpegRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<{ index: number; edge: 'start' | 'end' } | null>(null);
  const rafRef = useRef<number | null>(null);
  const segmentsRef = useRef<{ start: number; end: number | null }[] | null>(null);
  const durationRef = useRef<number>(0);
  const programmaticSeekRef = useRef(false);
  const programmaticPauseRef = useRef(false);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const seekDraggingRef = useRef(false);

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
      if (!v || !segs || v.paused) { rafRef.current = null; return; }
      const t = v.currentTime;
      const inSeg = segs.find(s => t >= s.start && t <= (s.end ?? dur));
      if (!inSeg) {
        const next = segs.filter(s => s.start > t).sort((a, b) => a.start - b.start)[0];
        if (next) {
          programmaticSeekRef.current = true;
          programmaticPauseRef.current = true;
          v.pause();
          v.muted = true;
          v.currentTime = next.start;
          v.addEventListener('seeked', () => { if (videoRef.current) { videoRef.current.muted = false; videoRef.current.play(); } }, { once: true });
        } else { v.pause(); }
        rafRef.current = null; return;
      }
      if (inSeg.end !== null && t >= inSeg.end - 0.2) {
        const idx = segs.indexOf(inSeg);
        const nextSeg = segs[idx + 1];
        if (nextSeg) {
          programmaticSeekRef.current = true;
          programmaticPauseRef.current = true;
          v.pause();
          v.muted = true;
          v.currentTime = nextSeg.start;
          v.addEventListener('seeked', () => { if (videoRef.current) { videoRef.current.muted = false; videoRef.current.play(); } }, { once: true });
        } else { v.pause(); }
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
      setProgress(0);
      setStatus("Ready");
    }
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

      // שליחת Whisper מיד (async) — בזמן שFFmpeg עושה 360p
      const form = new FormData();
      form.append('video', audioBlob, 'audio.mp3');
      const whisperPromise = fetch('/api/whisper', { method: 'POST', body: form });

      setStatus("Creating preview...");
      await ffmpeg.exec(['-i', 'input.mov', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-c:a', 'copy', 'preview.mp4']);
      const previewData = await ffmpeg.readFile('preview.mp4');
      setVideoUrl(URL.createObjectURL(new Blob([(previewData as any).buffer], { type: 'video/mp4' })));

      setStatus("Whisper is analyzing...");
      const res = await whisperPromise;
      const data = await res.json();

      if (data.segments) {
        setSegments(data.segments);
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
      let f = '', c = '';
      segments.forEach((s, i) => {
        const e = s.end ? s.end : duration;
        f += `[0:v]trim=start=${s.start}:end=${e},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=start=${s.start}:end=${e},asetpts=PTS-STARTPTS[a${i}];`;
        c += `[v${i}][a${i}]`;
      });
      f += `${c}concat=n=${segments.length}:v=1:a=1[vraw][outa];[vraw]fps=30,scale=1080:-2[outv]`;
      await ffmpegRef.current.exec(['-i', 'input.mov', '-filter_complex', f, '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', 'out.mp4']);
      const url = URL.createObjectURL(new Blob([(await ffmpegRef.current.readFile('out.mp4') as any).buffer], { type: 'video/mp4' }));
      const a = document.createElement('a'); a.href = url; a.download = `deVee_${videoFile.name}.mp4`; a.click();
    } catch (e) { setStatus("Error"); } finally { setProcessing(false); }
  };

  if (!authorized) {
    return (
      <main className="min-h-[100dvh] bg-[#050505] flex flex-col items-center justify-between p-8 text-center">
        <div className="w-full mt-4 md:mt-8 flex flex-col items-center space-y-2">
          <Image src="/logo.png" alt="Logo" width={110} height={35} className="mb-2 opacity-90" />
          <h1 className="text-[12px] tracking-[0.7em] font-bold uppercase italic text-white">Reels Cutter</h1>
        </div>
        <div className="flex-1 flex flex-col justify-center w-full max-w-[340px]">
          <form onSubmit={handleLogin} className="space-y-4 bg-[#0c0c0c]/40 p-8 rounded-[24px] border border-white/5 backdrop-blur-xl w-full">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3 px-4 text-white text-center tracking-[0.4em] text-[9px] focus:outline-none" placeholder="ACCESS KEY" />
            <button type="submit" className="w-full py-3 bg-[#D4AF37] text-black rounded-xl uppercase tracking-[0.3em] text-[8px] font-black">Enter</button>
          </form>
        </div>
        <LabelFooter />
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-[#050505] text-white flex flex-col items-center justify-between px-2 py-6 md:p-6 font-sans overflow-hidden">
      <div className="w-full mt-4 md:mt-8 flex flex-col items-center z-10 text-center space-y-2">
        <Image src="/logo.png" alt="Logo" width={110} height={35} className="mb-2 opacity-90" />
        <h1 className="text-[12px] tracking-[0.7em] font-bold uppercase italic text-white">Reels Cutter</h1>
        <p className="text-white/40 text-[7px] tracking-[0.3em] uppercase font-light">Pro High-Performance Engine</p>
      </div>

      <div className="w-full max-w-[550px] flex flex-col items-center gap-4 my-auto py-8">
        <div className="w-full bg-[#0c0c0c] border border-white/[0.05] rounded-[40px] p-4 md:p-10 relative group shadow-2xl">
          <div className="absolute -inset-2 bg-[#D4AF37] rounded-[50px] blur-[80px] opacity-[0.02]"></div>
          <div className="relative flex flex-col items-center">
            {videoUrl ? (
              <div className="w-full flex flex-col items-center">
                <div className="relative aspect-[9/16] w-[240px] bg-black rounded-[30px] overflow-hidden border border-white/10 mb-6 shadow-inner">
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                    onTimeUpdate={handleTimeUpdate}
                    onPlay={() => { setPaused(false); startLoop(); }}
                    onSeeked={(e) => {
                      if (programmaticSeekRef.current) { programmaticSeekRef.current = false; return; }
                      if (!e.currentTarget.paused && !draggingRef.current && !seekDraggingRef.current) startLoop();
                    }}
                    onPause={() => { stopLoop(); if (!programmaticPauseRef.current) setPaused(true); programmaticPauseRef.current = false; }}
                    className="w-full h-full object-cover"
                    playsInline
                    onClick={() => videoRef.current?.paused ? videoRef.current.play() : videoRef.current?.pause()}
                  />
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
                  <div className="w-full mb-6 space-y-2">

                    {/* ── Zoom controls ── */}
                    <div className="flex items-center justify-between px-0.5">
                      <span className="text-white/25 text-[7px] uppercase tracking-[0.2em]">Edit</span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => { setZoom(z => Math.max(1, z / 2)); if (zoom <= 2 && timelineContainerRef.current) timelineContainerRef.current.scrollLeft = 0; }}
                          className="w-7 h-7 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] rounded-lg text-white/50 text-sm transition-colors"
                        >−</button>
                        <span className="text-white/30 text-[9px] w-5 text-center">{zoom}×</span>
                        <button
                          onClick={() => setZoom(z => Math.min(16, z * 2))}
                          className="w-7 h-7 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] rounded-lg text-white/50 text-sm transition-colors"
                        >+</button>
                      </div>
                    </div>

                    {/* ── Scrollable timeline container (delete buttons + bars together) ── */}
                    <div ref={timelineContainerRef} className="w-full overflow-x-auto rounded-xl" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>

                      {/* Delete buttons row — above the timeline bar, scrolls with it */}
                      <div className="relative h-8" style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
                        {segments.map((seg, i) => (
                          <button
                            key={`del-${i}`}
                            className="absolute top-1 -translate-x-1/2 flex items-center justify-center w-6 h-6 rounded-full bg-red-500 hover:bg-red-600 text-white text-[12px] font-black transition-all leading-none border border-red-600 z-20"
                            style={{ left: `${(((seg.start + (seg.end ?? duration)) / 2) / duration) * 100}%` }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); setSegments(prev => prev ? prev.filter((_, idx) => idx !== i) : prev); }}
                          >×</button>
                        ))}
                      </div>

                      {/* Timeline bar */}
                      <div
                        ref={timelineRef}
                        className="relative h-20 md:h-14 bg-white/[0.03] border border-white/10 rounded-xl"
                        style={{ width: `${zoom * 100}%`, minWidth: '100%', touchAction: zoom > 1 ? 'pan-x' : 'none' }}
                      >
                        {/* Segment bars */}
                        {segments.map((seg, i) => (
                          <div
                            key={i}
                            className="absolute top-0 bottom-0 cursor-ew-resize"
                            style={{ left: `${(seg.start / duration) * 100}%`, width: `${(((seg.end ?? duration) - seg.start) / duration) * 100}%`, touchAction: 'none' }}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              e.currentTarget.setPointerCapture(e.pointerId);
                              const rect = e.currentTarget.getBoundingClientRect();
                              draggingRef.current = { index: i, edge: (e.clientX - rect.left) < rect.width / 2 ? 'start' : 'end' };
                            }}
                            onPointerMove={(e) => {
                              if (!draggingRef.current || !timelineRef.current) return;
                              const rect = timelineRef.current.getBoundingClientRect();
                              const t = Math.max(0, Math.min(e.clientX - rect.left, rect.width)) / rect.width * duration;
                              const { edge } = draggingRef.current;
                              setSegments(prev => prev ? prev.map((s, idx) => {
                                if (idx !== i) return s;
                                if (edge === 'start') return { ...s, start: Math.min(t, (s.end ?? duration) - 0.1) };
                                return { ...s, end: Math.max(t, s.start + 0.1) };
                              }) : prev);
                              if (videoRef.current) {
                                const newStart = edge === 'start' ? Math.min(t, (seg.end ?? duration) - 0.1) : seg.start;
                                videoRef.current.currentTime = newStart;
                              }
                            }}
                            onPointerUp={(e) => {
                              e.currentTarget.releasePointerCapture(e.pointerId);
                              draggingRef.current = null;
                              if (videoRef.current && !videoRef.current.paused) startLoop();
                            }}
                          >
                            {/* Left solid handle */}
                            <div className="absolute left-0 top-0 h-full w-2 bg-[#D4AF37] rounded-l-sm pointer-events-none" />
                            {/* Center body */}
                            <div className="absolute left-2 right-2 top-0 bottom-0 bg-[#D4AF37]/30 pointer-events-none" />
                            {/* Right solid handle */}
                            <div className="absolute right-0 top-0 h-full w-2 bg-[#D4AF37] rounded-r-sm pointer-events-none" />
                          </div>
                        ))}

                        {/* Playhead */}
                        <div className="absolute top-0 bottom-0 w-[2px] bg-white/70 pointer-events-none" style={{ left: `${(currentTime / duration) * 100}%` }} />
                      </div>
                    </div>

                    {/* ── Seek bar ── */}
                    <div
                      ref={seekBarRef}
                      className="relative w-full h-10 md:h-6 flex items-center cursor-pointer"
                      style={{ touchAction: 'none' }}
                      onClick={(e) => { if (!seekBarRef.current || !videoRef.current) return; const rect = seekBarRef.current.getBoundingClientRect(); videoRef.current.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}
                    >
                      <div className="relative w-full h-[3px] bg-white/[0.08] rounded-full pointer-events-none">
                        <div className="absolute left-0 top-0 h-full bg-[#D4AF37]/50 rounded-full" style={{ width: `${(currentTime / duration) * 100}%` }} />
                      </div>
                      <div
                        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 md:w-3 md:h-3 rounded-full bg-[#D4AF37] shadow-[0_0_8px_rgba(212,175,55,0.45)] cursor-grab active:cursor-grabbing pointer-events-auto"
                        style={{ left: `${(currentTime / duration) * 100}%` }}
                        onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); seekDraggingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
                        onPointerMove={(e) => { if (!seekDraggingRef.current || !seekBarRef.current || !videoRef.current) return; const rect = seekBarRef.current.getBoundingClientRect(); videoRef.current.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}
                        onPointerUp={(e) => { seekDraggingRef.current = false; e.currentTarget.releasePointerCapture(e.pointerId); if (videoRef.current && !videoRef.current.paused) startLoop(); }}
                      />
                    </div>

                    {/* ── Play / Pause toggle ── */}
                    <div className="flex justify-center">
                      <button
                        onClick={() => paused ? videoRef.current?.play() : videoRef.current?.pause()}
                        className="px-6 py-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg text-[9px] uppercase tracking-widest transition-colors"
                      >{paused ? 'Play' : 'Pause'}</button>
                    </div>

                  </div>
                )}
              </div>
            ) : (
              <label className="w-full cursor-pointer group/upload">
                <div className="border-2 border-dashed border-white/10 rounded-[30px] py-16 bg-white/[0.01] flex flex-col items-center justify-center transition-all">
                  <span className="text-[9px] uppercase tracking-[0.2em] text-white/50">Select Video</span>
                </div>
                <input type="file" className="hidden" onChange={handleFileUpload} accept="video/*" />
              </label>
            )}

            {!segments ? (
              <button onClick={analyzeVideo} disabled={processing || !videoFile} className="w-full py-5 rounded-[22px] bg-[#D4AF37] text-white uppercase tracking-[0.4em] text-[10px] font-black">
                {processing ? "Analysing..." : "Extract Audio"}
              </button>
            ) : (
              <button onClick={renderVideo} disabled={processing} className="w-full py-5 rounded-[22px] bg-[#D4AF37] text-black uppercase tracking-[0.4em] text-[10px] font-black">Export Master</button>
            )}
          </div>
        </div>
      </div>
      <LabelFooter />
    </main>
  );
}
