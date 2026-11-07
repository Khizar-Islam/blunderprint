import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import { MotionProvider } from "@/components/MotionProvider";
import { PerfProbeLoader } from "@/components/PerfProbeLoader";
import "./globals.css";

// next/font downloads these at build time and serves them from our own domain (no runtime Google request).
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Blunderprint",
  description: "Find the recurring mistakes in your Chess.com or Lichess games.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        <MotionProvider>{children}</MotionProvider>
        {/* Off unless the URL has ?perf=1 (then a small measuring box appears, bottom right). */}
        <PerfProbeLoader />
      </body>
    </html>
  );
}
