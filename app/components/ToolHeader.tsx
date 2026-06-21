'use client';
import { useState, useEffect } from 'react';
import { Menu, X } from 'lucide-react';

export function ToolHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  return (
    <>
      <header dir="ltr" className="absolute left-0 right-0 top-0 z-30 flex items-center justify-between px-6 py-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/deVee Sign Transperent-1.png"
          alt="deVee"
          className="h-10 w-auto object-contain"
        />
        <button
          type="button"
          aria-label="Toggle menu"
          onClick={() => setMenuOpen(v => !v)}
          className="header-menu-btn relative z-50 p-2 text-white/80 hover:text-white transition-colors duration-300 rounded"
        >
          {menuOpen ? <X className="h-7 w-7" /> : <Menu className="h-6 w-6" />}
        </button>
      </header>

      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/80 backdrop-blur-sm"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <div
        className={`fixed right-0 top-0 z-50 h-full w-80 bg-black border-l border-white/10 transition-transform duration-300 ease-in-out ${
          menuOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <nav className="flex flex-col items-center justify-start h-full space-y-8 pt-24" style={{ fontFamily: "'Montserrat', sans-serif" }}>
          <style>{`@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@800;900&display=swap');`}</style>
          <a
            href="https://devee-music.com"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMenuOpen(false)}
            className="text-2xl font-bold text-white hover:text-[#ea580c] transition-colors duration-300 tracking-wider"
          >
            Home
          </a>
          <span className="text-2xl font-bold text-white/30 tracking-wider cursor-default">
            Info
          </span>
        </nav>
      </div>
    </>
  );
}
