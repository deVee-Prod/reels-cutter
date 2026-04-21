"use client";

import React, { useState } from 'react';

export default function ReelsCutterPage() {
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("Ready"); 
  const [videoFile, setVideoFile] = useState<File | null>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setVideoFile(file);
  };

  const processVideo = async () => {
    if (!videoFile) return;
    setProcessing(true);
    setStatus("Uploading to Server...");
    
    try {
      // 1. קודם כל נסרוק את השתיקות בדפדפן כדי לחסוך זמן לשרת
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const { toBlobURL, fetchFile } = await import('@ffmpeg/util');
      const ffmpeg = new FFmpeg();
      
      setStatus("Scanning Audio (Local)...");
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });

      await ffmpeg.writeFile('input.mov', await fetchFile(videoFile));
      
      let logData = "";
      ffmpeg.on('log', ({ message }) => { logData += message + "\n"; });
      await ffmpeg.exec(['-i', 'input.mov', '-vn', '-af', 'silencedetect=noise=-30dB:d=0.4', '-f', 'null', '-']);

      const silenceStarts = [...logData.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]));
      const silenceEnds = [...logData.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));

      let segments: { start: number, end: number | null }[] = [];
      let lastEnd = 0;
      silenceStarts.forEach((start, i) => {
        if (start > lastEnd) segments.push({ start: lastEnd, end: start });
        lastEnd = silenceEnds[i];
      });
      segments.push({ start: lastEnd, end: null });

      setStatus("Server Processing (Fingers Crossed)...");

      // 2. שולחים את הווידאו וההוראות ל-API
      const formData = new FormData();
      formData.append("video", videoFile);
      formData.append("segments", JSON.stringify(segments));

      const response = await fetch("/api/cut", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Server Error or Timeout");

      setStatus("Downloading...");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Vercel_Cut_${videoFile.name}.mp4`;
      a.click();
      
      setStatus("Done!");

    } catch (e: any) {
      console.error(e);
      setStatus("Error: " + e.message);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#050505] text-white flex flex-col items-center justify-between py-12 px-6 font-sans">
      <div className="flex flex-col items-center z-10 text-center">
        <h1 className="text-[12px] tracking-[0.7em] font-bold uppercase italic text-[#D4AF37]">Reels Cutter</h1>
        <p className="text-gray-600 text-[7px] tracking-[0.3em] mt-2 uppercase font-light">Server Engine Test</p>
      </div>

      <div className="w-full max-w-[550px] bg-[#0c0c0c] border border-white/[0.03] rounded-[40px] p-10 shadow-2xl relative">
        <div className="relative flex flex-col items-center">
          <label className="w-full cursor-pointer group">
            <div className="border border-dashed border-white/[0.07] group-hover:border-[#D4AF37]/40 rounded-[30px] py-16 bg-white/[0.01] transition-all">
              <span className="text-[9px] uppercase tracking-[0.2em] text-gray-500">
                {videoFile ? videoFile.name : "Select Video"}
              </span>
            </div>
            <input type="file" className="hidden" onChange={handleFileUpload} accept="video/*" />
          </label>

          {processing && (
            <div className="w-full mt-8 px-2 text-center text-[10px] text-[#D4AF37] animate-pulse">
              {status}
            </div>
          )}

          <button 
            onClick={processVideo}
            disabled={processing || !videoFile}
            className="w-full mt-10 py-4 rounded-[20px] uppercase tracking-[0.2em] text-[10px] font-bold bg-[#D4AF37] text-black hover:scale-[1.02] transition-all"
          >
            {processing ? "Waiting for Server..." : "Test on Vercel"}
          </button>
        </div>
      </div>
      <footer className="opacity-50 text-[6px] tracking-[0.2em] uppercase font-medium">deVee Boutique Label</footer>
    </main>
  );
}