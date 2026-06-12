import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  // בדיקת cookie
  const cookie = req.cookies.get('session_access');
  if (cookie?.value !== 'granted') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await req.formData();
  const audioFile = formData.get('video') as File;
  if (!audioFile) return NextResponse.json({ error: 'Missing audio' }, { status: 400 });

  try {
    const whisperForm = new FormData();
    whisperForm.append('file', audioFile, 'audio.mp3');
    whisperForm.append('model', 'whisper-1');
    whisperForm.append('response_format', 'verbose_json');
    whisperForm.append('timestamp_granularities[]', 'word');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: whisperForm,
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.text();
      throw new Error(`Whisper error: ${err}`);
    }

    const whisperData = await whisperRes.json();
    const words: { word: string; start: number; end: number }[] = whisperData.words ?? [];

    // ─── DEBUG ───────────────────────────────────────────────
    console.log('=== WHISPER DEBUG ===');
    console.log('Total words:', words.length);
    console.log('Duration:', whisperData.duration);
    words.forEach((w, i) => {
      const gap = i > 0 ? (w.start - words[i - 1].end).toFixed(2) : '0';
      console.log(`[${i}] "${w.word}" ${w.start.toFixed(2)}s → ${w.end.toFixed(2)}s | gap before: ${gap}s`);
    });
    // ─────────────────────────────────────────────────────────

    const segments = buildSpeechSegments(words, 0.4);

    console.log('=== SEGMENTS ===');
    segments.forEach((s, i) => {
      console.log(`[${i}] start: ${s.start.toFixed(2)}s end: ${s.end !== null ? s.end.toFixed(2) + 's' : 'END'}`);
    });

    const subtitleWords = words.map((w, index) => {
      const start = Math.max(0, w.start - 0.04);
      let end = w.end;
      const nextWord = words[index + 1];
      if (nextWord) {
        const nextStart = nextWord.start - 0.04;
        if (end > nextStart) end = Math.max(start + 0.05, nextStart - 0.01);
      }
      return { word: w.word, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
    });

    return NextResponse.json({ segments, words: subtitleWords });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

function buildSpeechSegments(
  words: { start: number; end: number }[],
  threshold: number
): { start: number; end: number | null }[] {
  if (words.length === 0) return [{ start: 0, end: null }];

  const segments: { start: number; end: number | null }[] = [];
  let segStart = words[0].start;
  let segEnd = words[0].end;

  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - segEnd;
    if (gap >= threshold) {
      segments.push({ start: Math.max(0, segStart - 0.1), end: segEnd });
      segStart = words[i].start;
    }
    segEnd = words[i].end;
  }
  segments.push({ start: Math.max(0, segStart - 0.1), end: null });

  return segments;
}

export const maxDuration = 60;
