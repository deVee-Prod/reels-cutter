import { NextRequest, NextResponse } from 'next/server';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

// כאן נגלה אם ל-Vercel יש FFmpeg מובנה (לפעמים יש להם בסביבת הריצה)
const FFMPEG_PATH = process.env.VERCEL ? 'ffmpeg' : (process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg');
const TMP_DIR = process.env.VERCEL ? '/tmp' : join(process.cwd(), 'tmp');

async function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) {
    await mkdir(TMP_DIR, { recursive: true });
  }
}

async function cleanup(...files: string[]) {
  await Promise.allSettled(files.map(f => unlink(f)));
}

export async function POST(req: NextRequest) {
  await ensureTmpDir();

  const id = randomUUID();
  const formData = await req.formData();
  const videoFile = formData.get('video') as File;
  const segmentsJson = formData.get('segments') as string;

  if (!videoFile || !segmentsJson) {
    return NextResponse.json({ error: 'Missing data' }, { status: 400 });
  }

  const segments: { start: number; end: number | null }[] = JSON.parse(segmentsJson);
  const ext = videoFile.name.split('.').pop()?.toLowerCase() ?? 'mov';
  const inputPath = join(TMP_DIR, `input_${id}.${ext}`);
  const outputPath = join(TMP_DIR, `output_${id}.mp4`);

  await writeFile(inputPath, Buffer.from(await videoFile.arrayBuffer()));

  try {
    let filterComplex = '';
    let concatInputs = '';
    
    segments.forEach((seg, i) => {
      const start = seg.start.toFixed(3);
      const endOpt = seg.end !== null ? `:end=${seg.end.toFixed(3)}` : '';
      filterComplex += `[0:v]trim=start=${start}${endOpt},setpts=PTS-STARTPTS[v${i}];`;
      filterComplex += `[0:a]atrim=start=${start}${endOpt},asetpts=PTS-STARTPTS[a${i}];`;
      concatInputs += `[v${i}][a${i}]`;
    });

    filterComplex += `${concatInputs}concat=n=${segments.length}:v=1:a=1[vraw][outa];`;
    filterComplex += `[vraw]scale=1080:-2:flags=bilinear[outv]`;

    const cmd = [
      `"${FFMPEG_PATH}"`,
      '-y',
      '-threads', '0',
      '-i', `"${inputPath}"`,
      '-filter_complex', `"${filterComplex}"`,
      '-map', '"[outv]"',
      '-map', '"[outa]"',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      `"${outputPath}"`
    ].join(' ');

    await execAsync(cmd);

    const outputBuffer = await readFile(outputPath);
    await cleanup(inputPath, outputPath);

    return new NextResponse(outputBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="Reels_${videoFile.name}.mp4"`,
      },
    });

  } catch (e: any) {
    await cleanup(inputPath, outputPath);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export const maxDuration = 60;