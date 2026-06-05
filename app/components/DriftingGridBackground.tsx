'use client';
import { useEffect, useState } from 'react';

const IMGS = [
  '/bg-crush.png',
  '/bg-gondola.jpg',
  '/bg-shadow.png',
  '/bg-zohar.jpg',
  '/bg-yali.jpg',
  '/bg-fck-that.jpg',
  '/bg-cat.png',
];

const IMAGE_SETS: string[][] = [
  [
    IMGS[0], IMGS[1], IMGS[2], IMGS[3],
    IMGS[4], IMGS[5], IMGS[6], IMGS[0],
    IMGS[2], IMGS[6], IMGS[5], IMGS[4],
    IMGS[3], IMGS[1], IMGS[6], IMGS[2],
  ],
  [
    IMGS[3], IMGS[6], IMGS[1], IMGS[0],
    IMGS[2], IMGS[4], IMGS[3], IMGS[5],
    IMGS[6], IMGS[2], IMGS[4], IMGS[1],
    IMGS[5], IMGS[3], IMGS[0], IMGS[6],
  ],
  [
    IMGS[6], IMGS[4], IMGS[0], IMGS[5],
    IMGS[1], IMGS[3], IMGS[6], IMGS[2],
    IMGS[5], IMGS[0], IMGS[1], IMGS[3],
    IMGS[4], IMGS[6], IMGS[5], IMGS[2],
  ],
];

export function DriftingGridBackground() {
  const [setIndex, setSetIndex] = useState(0);
  const [opacity, setOpacity] = useState(0.38);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const interval = setInterval(() => {
      setOpacity(0.1);
      timeout = setTimeout(() => {
        setSetIndex(i => (i + 1) % IMAGE_SETS.length);
        setOpacity(0.38);
      }, 800);
    }, 5000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, []);

  const images = IMAGE_SETS[setIndex];

  return (
    <div className="bg-drift-container">
      <div className="bg-drift-overlay-dark" />
      <div className="bg-drift-glow-orange" />
      <div className="bg-drift-overlay-grad" />
      <div
        className="bg-drift-grid bg-drift-grid-animated"
        style={{ opacity, transition: 'opacity 0.8s ease' }}
      >
        {images.map((src, i) => (
          <div key={i} className="bg-drift-cell">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" />
          </div>
        ))}
      </div>
    </div>
  );
}
