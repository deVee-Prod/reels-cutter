"use client";

import React, { useState, useRef, useEffect } from 'react';
import Image from 'next/image';

export default function ReelsCutterPage() {
  const [loaded, setLoaded] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0); 
  const [status, setStatus] = useState("Ready"); 
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const ffmpegRef = useRef<any>(null);

  useEffect(() => { loadFFmpeg(); }, []);

  const loadFFmpeg = async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const ffmpeg = new FFmpeg();
    ffmpegRef.current = ffmpeg;
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    ffmpeg.on('progress', ({ progress }) => { setProgress(Math.round(progress * 100)); });
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    setLoaded(true);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setVideoFile(file);
  };

  const processVideo = async () => {
    if (!videoFile || !loaded || !ffmpegRef.current) return;
    setProcessing(true); setProgress(0); setStatus("Analysing Audio...");
    const { fetchFile } = await import('@ffmpeg/util');
    const ffmpeg = ffmpegRef.current;
    try {
      const inputName = 'input.mov'; const outputName = 'output.mp4';
      await ffmpeg.writeFile(inputName, await fetchFile(videoFile));
      let logData = "";
      const logHandler = ({ message }: { message: string }) => { logData += message + "\n"; };
      ffmpeg.on('log', logHandler);
      await ffmpeg.exec(['-i', inputName, '-vn', '-af', 'silencedetect=noise=-30dB:d=0.4', '-f', 'null', '-']);
      ffmpeg.off('log', logHandler);
      const silenceStarts = [...logData.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]));
      const silenceEnds = [...logData.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));
      if (silenceStarts.length === 0) { alert("לא נמצאו שתיקות!"); setProcessing(false); return; }
      let segments: { start: number, end: number | null }[] = []; let lastEnd = 0;
      silenceStarts.forEach((start, i) => { if (start > lastEnd) segments.push({ start: lastEnd, end: start }); lastEnd = silenceEnds[i]; });
      segments.push({ start: lastEnd, end: null });
      setStatus("Rendering 1080p Pro Mode...");
      let filterComplex = ''; let concatInputs = '';
      segments.forEach((seg, i) => {
        const start = seg.start.toFixed(3);
        const endOpt = seg.end !== null ? `:end=${seg.end.toFixed(3)}` : '';
        filterComplex += `[0:v]trim=start=${start}${endOpt},setpts=PTS-STARTPTS,fps=30,scale=1080:-2[v${i}];`;
        filterComplex += `[0:a]atrim=start=${start}${endOpt},asetpts=PTS-STARTPTS[a${i}];`;
        concatInputs += `[v${i}][a${i}]`;
      });
      filterComplex += `${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`;
      await ffmpeg.exec(['-i', inputName, '-filter_complex', filterComplex, '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-c:a', 'aac', '-b:a', '128k', outputName]);
      setStatus("Done!"); setProgress(100);
      const data = await ffmpeg.readFile(outputName);
      const url = URL.createObjectURL(new Blob([(data as any).buffer], { type: 'video/mp4' }));
      const a = document.createElement('a'); a.href = url; a.download = `deVee_Pro_1080p_${videoFile.name}.mp4`; a.click();
    } catch (e) { console.error(e); setStatus("Error processing"); } finally { setProcessing(false); }
  };

  return (
    <main className="min-h-screen bg-[#050505] text-white flex flex-col items-center justify-between py-12 px-6 font-sans overflow-hidden">
      
      {/* Top Logo Section */}
      <div className="flex flex-col items-center z-10 text-center space-y-2">
        <Image src="/logo.png" alt="Logo" width={110} height={35} className="mb-2 opacity-90" />
        <h1 className="text-[12px] tracking-[0.7em] font-bold uppercase italic text-white">Reels Cutter</h1>
        <p className="text-white/40 text-[7px] tracking-[0.3em] uppercase font-light">Pro High-Performance Engine</p>
      </div>

      <div className="w-full max-w-[550px] flex flex-col items-center gap-6">
        
        {/* Device Optimization Hint */}
        <p className="text-[8px] tracking-[0.2em] text-[#D4AF37] uppercase font-medium opacity-80">
          Optimized for iPhone • Desktop slow-down may occur
        </p>

        {/* Interface Card */}
        <div className="w-full bg-[#0c0c0c] border border-white/[0.05] rounded-[40px] p-10 relative group shadow-[0_0_50px_rgba(0,0,0,0.5)]">
          
          <div className="absolute -inset-2 bg-[#D4AF37] rounded-[50px] blur-[80px] opacity-[0.02] group-hover:opacity-[0.12] transition-opacity duration-1000"></div>
          <div className="absolute inset-0 bg-[#D4AF37] rounded-[40px] blur-[20px] opacity-0 group-hover:opacity-[0.05] transition-opacity duration-700"></div>
          
          <div className="relative flex flex-col items-center">
            
            <label className="w-full cursor-pointer group/upload">
              <div className="border-2 border-dashed border-white/10 group-hover/upload:border-white/30 rounded-[30px] py-16 bg-white/[0.01] hover:bg-white/[0.03] flex flex-col items-center justify-center transition-all duration-500 shadow-inner">
                <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-4 group-hover/upload:scale-110 transition-transform shadow-lg border border-white/5">
                  <svg className="w-6 h-6 text-white/50 group-hover/upload:text-white transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                </div>
                <span className="text-[9px] uppercase tracking-[0.2em] text-white/50 group-hover/upload:text-white transition-colors text-center px-4">
                  {videoFile ? videoFile.name : "Select Vertical Video"}
                </span>
                <span className="text-[7px] text-white/30 mt-2 uppercase tracking-widest">Portrait Format Only</span>
              </div>
              <input type="file" className="hidden" onChange={handleFileUpload} accept="video/*" />
            </label>

            {processing && (
              <div className="w-full mt-8 px-2">
                <div className="flex justify-between text-[7px] uppercase tracking-[0.1em] text-white/60 mb-2">
                  <span className="animate-pulse">{status}</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full h-[2px] bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full bg-[#D4AF37] shadow-[0_0_15px_#D4AF37] transition-all duration-500" style={{ width: `${progress}%` }}></div>
                </div>
              </div>
            )}

            <button 
              onClick={processVideo}
              disabled={!loaded || processing || !videoFile}
              className={`w-full mt-10 py-5 rounded-[22px] uppercase tracking-[0.3em] text-[10px] font-black transition-all
                ${!videoFile ? 'bg-white/5 text-white/20 border border-white/5' : 
                  processing ? 'bg-white/10 text-white animate-pulse' : 
                  'bg-[#D4AF37] text-black shadow-[0_10px_40px_rgba(212,175,55,0.25)] hover:scale-[1.02] active:scale-[0.98]'}
              `}
            >
              {processing ? "Rendering..." : "Generate Pro Reel"}
            </button>
          </div>
        </div>
      </div>

     {/* Footer Branding Section */}
<div className="flex flex-col items-center gap-4 mt-2">
  <p className="footer-text text-[7px] tracking-[0.15em] font-light text-white/50 uppercase">
    Powered By deVee Boutique Label
  </p>
  <Image src="/label_logo.jpg" alt="deVee Label" width={32} height={32} className="rounded-full opacity-100 shadow-xl" />
</div>

    </main>
  );
}