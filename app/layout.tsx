import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { DriftingGridBackground } from "./components/DriftingGridBackground";
import { ToolHeader } from './components/ToolHeader';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: 'Reels Cutter',
  description: "The ultimate editor for Reels & Shorts: cut and create subtitles.",
      icons: [
    { rel: 'icon', url: '/favicon-v2.ico' },
    { rel: 'icon', url: '/favicon-48-v2.png', sizes: '48x48', type: 'image/png' },
    { rel: 'icon', url: '/favicon-32-v2.png', sizes: '32x32', type: 'image/png' },
    { rel: 'icon', url: '/favicon-192-v2.png', sizes: '192x192', type: 'image/png' },
    { rel: 'icon', url: '/favicon-512-v2.png', sizes: '512x512', type: 'image/png' },
    { rel: 'apple-touch-icon', url: '/favicon-512-v2.png', sizes: '512x512', type: 'image/png' },
  ],

    { rel: 'icon', url: '/favicon-48-v2.png', sizes: '48x48', type: 'image/png' },
    { rel: 'icon', url: '/favicon-32-v2.png', sizes: '32x32', type: 'image/png' },
    { rel: 'icon', url: '/favicon-192-v2.png', sizes: '192x192', type: 'image/png' },
    { rel: 'icon', url: '/favicon-512-v2.png', sizes: '512x512', type: 'image/png' },
    { rel: 'apple-touch-icon', url: '/favicon-512-v2.png', sizes: '512x512', type: 'image/png' },
  ],
}
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="relative min-h-full flex flex-col">
        <DriftingGridBackground />
        <div className="relative z-10 flex flex-col min-h-full">
          <ToolHeader />
          {children}
        </div>
      </body>
    </html>
  );
}
