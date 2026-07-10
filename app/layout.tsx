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
  icons: {
    icon: '/favicon.png',
  },
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
