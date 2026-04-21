"use client";

import React, { useState, useRef, useEffect } from 'react';

export default function ReelsCutterPage() {
  const [loaded, setLoaded] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0); 
  const [status, setStatus] = useState("Ready"); 
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const ffmpegRef = useRef<any>(null);

  useEffect(() => {
    loadFFmpeg();
  }, []);

  const loadFFmpeg = async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const ffmpeg = new FFmpeg();
    ffmpegRef.current = ffmpeg;

    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    
    ffmpeg.on('progress', ({ progress }) => {
      setProgress(Math.round(progress * 100));
    });

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
    setProcessing(true);
    setProgress(0);
    setStatus("Analysing Audio...");
    
    const { fetchFile } = await import('@ffmpeg/util');
    const ffmpeg = ffmpegRef.current;
    
    try {
      const inputName = 'input.mov';
      const outputName = 'output.mp4';
      await ffmpeg.writeFile(inputName, await fetchFile(videoFile));

      let logData = "";
      const logHandler = ({ message }: { message: string }) => { logData += message + "\n"; };
      ffmpeg.on('log', logHandler);
      await ffmpeg.exec(['-i', inputName, '-vn', '-af', 'silencedetect=noise=-30dB:d=0.4', '-f', 'null', '-']);
      ffmpeg.off('log', logHandler);

      const silenceStarts = [...logData.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]));
      const silenceEnds = [...logData.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));

      if (silenceStarts.length === 0) {
        alert("לא נמצאו שתיקות!");
        setProcessing(false);
        return;
      }

      let segments: { start: number, end: number | null }[] = [];
      let lastEnd = 0;
      silenceStarts.forEach((start, i) => {
        if (start > lastEnd) segments.push({ start: lastEnd, end: start });
        lastEnd = silenceEnds[i];
      });
      segments.push({ start: lastEnd, end: null });

      setStatus("Rendering 1080p Pro Mode...");

      let filterComplex = '';
      let concatInputs = '';
      segments.forEach((seg, i) => {
        const start = seg.start.toFixed(3);
        const endOpt = seg.end !== null ? `:end=${seg.end.toFixed(3)}` : '';
        // עדכון לרזולוציית 1080p
        filterComplex += `[0:v]trim=start=${start}${endOpt},setpts=PTS-STARTPTS,fps=30,scale=1080:-2[v${i}];`;
        filterComplex += `[0:a]atrim=start=${start}${endOpt},asetpts=PTS-STARTPTS[a${i}];`;
        concatInputs += `[v${i}][a${i}]`;
      });
      filterComplex += `${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

      await ffmpeg.exec([
        '-i', inputName,
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-map', '[outa]',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '24', // שיפור איכות ל-1080p
        '-c:a', 'aac',
        '-b:a', '128k',
        outputName
      ]);

      setStatus("Done!");
      setProgress(100);

      const data = await ffmpeg.readFile(outputName);
      const url = URL.createObjectURL(new Blob([(data as any).buffer], { type: 'video/mp4' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `deVee_Pro_1080p_${videoFile.name}.mp4`;
      a.click();

    } catch (e) {
      console.error(e);
      setStatus("Error processing");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#050505] text-white flex flex-col items-center justify-between py-12 px-6 font-sans overflow-hidden">
      <div className="flex flex-col items-center z-10 text-center">
        <h1 className="text-[12px] tracking-[0.7em] font-bold uppercase italic text-[#D4AF37]">Reels Cutter</h1>
        <p className="text-gray-600 text-[7px] tracking-[0.3em] mt-2 uppercase font-light">1080p High-Performance Engine</p>
      </div>

      <div className="w-full max-w-[550px] bg-[#0c0c0c] border border-white/[0.03] rounded-[40px] p-10 shadow-2xl relative">
        <div className="absolute -inset-2 bg-[#D4AF37] rounded-[50px] blur-[60px] opacity-[0.05]"></div>
        
        <div className="relative flex flex-col items-center">
          <label className="w-full cursor-pointer group">
            <div className="border border-dashed border-white/[0.07] group-hover:border-[#D4AF37]/40 rounded-[30px] py-16 bg-white/[0.01] transition-all duration-500">
              <span className="text-[9px] uppercase tracking-[0.2em] text-gray-500 group-hover:text-gray-300">
                {videoFile ? videoFile.name : "Select 4K Source Video"}
              </span>
            </div>
            <input type="file" className="hidden" onChange={handleFileUpload} accept="video/*" />
          </label>

          {processing && (
            <div className="w-full mt-8 px-2">
              <div className="flex justify-between text-[7px] uppercase tracking-[0.1em] text-gray-400 mb-2">
                <span className="animate-pulse">{status}</span>
                <span>{progress}%</span>
              </div>
              <div className="w-full h-[2px] bg-white/5 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-[#D4AF37] transition-all duration-500" 
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
            </div>
          )}

          <button 
            onClick={processVideo}
            disabled={!loaded || processing || !videoFile}
            className={`w-full mt-10 py-4 rounded-[20px] uppercase tracking-[0.2em] text-[10px] font-bold transition-all duration-500
              ${!videoFile ? 'bg-white/5 text-gray-700' : 
                processing ? 'bg-[#D4AF37]/20 text-[#D4AF37]' : 
                'bg-[#D4AF37] text-black hover:scale-[1.02] shadow-lg'}
            `}
          >
            {processing ? "Rendering 1080p..." : "Generate Pro Reel"}
          </button>
        </div>
      </div>

      <footer className="opacity-50 text-[6px] tracking-[0.2em] uppercase font-medium text-[#D4AF37]">deVee Boutique Label</footer>
    </main>
  );
}