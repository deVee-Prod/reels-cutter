"use client";

import React, { useState, useRef, useEffect } from 'react';
import Image from 'next/image';

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

  const ffmpegRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<{ index: number; edge: 'start' | 'end' } | null>(null);
  const segmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segmentsRef = useRef<{ start: number; end: number | null }[] | null>(null);
  const durationRef = useRef<number>(0);
  const programmaticSeekRef = useRef(false);
  const scheduleJumpRef = useRef<(time: number) => void>(() => {});

  useEffect(() => {
    if (document.cookie.includes('session_access=granted')) {
      setAuthorized(true);
      loadFFmpeg();
    }
  }, []);

  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => () => { if (segmentTimerRef.current) clearTimeout(segmentTimerRef.current); }, []);

  const clearSegmentTimer = () => {
    if (segmentTimerRef.current !== null) {
      clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
  };

  const scheduleJumpFromTime = (time: number) => {
    clearSegmentTimer();
    const segs = segmentsRef.current;
    const dur = durationRef.current;
    const video = videoRef.current;
    if (!segs || !video) return;

    const inSeg = segs.find(s => time >= s.start && time <= (s.end ?? dur));
    if (!inSeg) {
      const next = segs.filter(s => s.start > time).sort((a, b) => a.start - b.start)[0];
      if (next) {
        programmaticSeekRef.current = true;
        video.currentTime = next.start;
        scheduleJumpRef.current(next.start);
      } else {
        video.pause();
      }
      return;
    }
    if (inSeg.end === null) return;
    const msUntilEnd = (inSeg.end - time) * 1000;
    const idx = segs.indexOf(inSeg);
    const nextSeg = segs[idx + 1];
    segmentTimerRef.current = setTimeout(() => {
      const v = videoRef.current;
      if (!v || v.paused) return;
      programmaticSeekRef.current = true;
      if (nextSeg) {
        v.currentTime = nextSeg.start;
        scheduleJumpRef.current(nextSeg.start);
      } else {
        v.pause();
      }
    }, Math.max(0, msUntilEnd - 60));
  };
  scheduleJumpRef.current = scheduleJumpFromTime;

  useEffect(() => {
    const handleMouseUp = () => {
      draggingRef.current = null;
      if (videoRef.current && !videoRef.current.paused) scheduleJumpRef.current(videoRef.current.currentTime);
    };
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !duration || !timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      let x = e.clientX - rect.left;
      x = Math.max(0, Math.min(x, rect.width));
      const newTime = (x / rect.width) * duration;
      const { index, edge } = draggingRef.current;
      setSegments(prev => {
        if (!prev) return prev;
        const newSegs = [...prev];
        if (edge === 'start') {
           newSegs[index].start = Math.min(newTime, (newSegs[index].end ?? duration) - 0.1);
        } else {
           newSegs[index].end = Math.max(newTime, newSegs[index].start + 0.1);
        }
        return newSegs;
      });
      if (videoRef.current) videoRef.current.currentTime = newTime;
    };
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [duration]);

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
      await ffmpeg.writeFile('input.mov', await fetchFile(videoFile));
      
      // 1. חילוץ סאונד ל-Whisper
      await ffmpeg.exec(['-i', 'input.mov', '-vn', '-ar', '16000', '-ac', '1', 'whisper.mp3']);
      const audioData = await ffmpeg.readFile('whisper.mp3');
      const audioBlob = new Blob([(audioData as any).buffer], { type: 'audio/mpeg' });

      // 2. יצירת Proxy קליל לתצוגה מקדימה (360p)
      setStatus("Creating Smooth Preview...");
      await ffmpeg.exec(['-i', 'input.mov', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-c:a', 'copy', 'preview.mp4']);
      const previewData = await ffmpeg.readFile('preview.mp4');
      const previewUrl = URL.createObjectURL(new Blob([(previewData as any).buffer], { type: 'video/mp4' }));
      setVideoUrl(previewUrl);

      // 3. שליחה ל-Whisper
      setStatus("Whisper is analyzing...");
      const form = new FormData();
      form.append('video', audioBlob, 'audio.mp3');
      const res = await fetch('/api/whisper', { method: 'POST', body: form });
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
    setStatus("Rendering 1080p Master...");
    try {
      const { fetchFile } = await import('@ffmpeg/util');
      // חשוב: משתמשים ב-videoFile המקורי ולא ב-Proxy
      await ffmpegRef.current.writeFile('input.mov', await fetchFile(videoFile));
      let f = '', c = '';
      segments.forEach((s, i) => {
        const e = s.end ? s.end : duration;
        f += `[0:v]trim=start=${s.start}:end=${e},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=start=${s.start}:end=${e},asetpts=PTS-STARTPTS[a${i}];`;
        c += `[v${i}][a${i}]`;
      });
      f += `${c}concat=n=${segments.length}:v=1:a=1[vraw][outa];[vraw]fps=30,scale=1080:-2[outv]`;
      await ffmpegRef.current.exec(['-i', 'input.mov', '-filter_complex', f, '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-crf', '24', 'out.mp4']);
      const url = URL.createObjectURL(new Blob([(await ffmpegRef.current.readFile('out.mp4') as any).buffer], { type: 'video/mp4' }));
      const a = document.createElement('a'); a.href = url; a.download = `deVee_${videoFile.name}.mp4`; a.click();
    } catch (e) { setStatus("Error"); } finally { setProcessing(false); }
  };

  const LabelFooter = () => (
    <div className="w-full mb-4 md:mb-8 flex flex-col items-center gap-4">
      <p className="text-[7px] tracking-[0.15em] font-light text-white/50 uppercase">
        Powered By deVee Boutique Label
      </p>
      <Image src="/label_logo.jpg" alt="deVee Label" width={48} height={48} className="rounded-full opacity-100 shadow-xl" />
    </div>
  );

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
    <main className="min-h-[100dvh] bg-[#050505] text-white flex flex-col items-center justify-between p-6 font-sans overflow-hidden">
      <div className="w-full mt-4 md:mt-8 flex flex-col items-center z-10 text-center space-y-2">
        <Image src="/logo.png" alt="Logo" width={110} height={35} className="mb-2 opacity-90" />
        <h1 className="text-[12px] tracking-[0.7em] font-bold uppercase italic text-white">Reels Cutter</h1>
        <p className="text-white/40 text-[7px] tracking-[0.3em] uppercase font-light">Pro High-Performance Engine</p>
      </div>

      <div className="w-full max-w-[550px] flex flex-col items-center gap-4 my-auto py-8">
        <div className="w-full bg-[#0c0c0c] border border-white/[0.05] rounded-[40px] p-10 relative group shadow-2xl">
          <div className="absolute -inset-2 bg-[#D4AF37] rounded-[50px] blur-[80px] opacity-[0.02]"></div>
          <div className="relative flex flex-col items-center">
            {videoUrl ? (
              <div className="w-full flex flex-col items-center">
                <div className="relative aspect-[9/16] w-[240px] bg-black rounded-[30px] overflow-hidden border border-white/10 mb-6 shadow-inner">
                  <video ref={videoRef} src={videoUrl} onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} onTimeUpdate={handleTimeUpdate} onPlay={(e) => scheduleJumpFromTime(e.currentTarget.currentTime)} onSeeked={(e) => { if (programmaticSeekRef.current) { programmaticSeekRef.current = false; return; } if (!e.currentTarget.paused && !draggingRef.current) scheduleJumpFromTime(e.currentTarget.currentTime); }} onPause={clearSegmentTimer} className="w-full h-full object-cover" playsInline onClick={() => videoRef.current?.paused ? videoRef.current.play() : videoRef.current?.pause()} />
                  {processing && <div className="absolute inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center p-4 text-center"><span className="text-[#D4AF37] text-[10px] uppercase tracking-widest animate-pulse font-bold">{status}</span></div>}
                </div>
                
                {segments && (
                  <div className="w-full mb-6">
                    <div ref={timelineRef} className="relative h-10 bg-white/[0.03] rounded-xl border border-white/10 overflow-hidden mb-4 cursor-pointer" onClick={(e) => { if (!draggingRef.current && videoRef.current) videoRef.current.currentTime = ((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.getBoundingClientRect().width) * duration; }}>
                      {segments.map((seg, i) => (
                        <div key={i} className="absolute h-full bg-[#D4AF37]/50 border-x border-[#D4AF37]" style={{ left: `${(seg.start / duration) * 100}%`, width: `${(((seg.end ?? duration) - seg.start) / duration) * 100}%` }}>
                          <div className="absolute left-0 w-2 h-full cursor-ew-resize" onMouseDown={(e) => { e.stopPropagation(); draggingRef.current = { index: i, edge: 'start' }; }} />
                          <div className="absolute right-0 w-2 h-full cursor-ew-resize" onMouseDown={(e) => { e.stopPropagation(); draggingRef.current = { index: i, edge: 'end' }; }} />
                        </div>
                      ))}
                      <div className="absolute top-0 bottom-0 w-[2px] bg-red-500" style={{ left: `${(currentTime / duration) * 100}%`, pointerEvents: 'none' }} />
                    </div>
                    <div className="flex justify-center gap-4 mb-4">
                       <button onClick={() => videoRef.current?.play()} className="px-4 py-2 bg-white/5 rounded-lg text-[9px] uppercase tracking-widest">Play</button>
                       <button onClick={() => videoRef.current?.pause()} className="px-4 py-2 bg-white/5 rounded-lg text-[9px] uppercase tracking-widest">Pause</button>
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