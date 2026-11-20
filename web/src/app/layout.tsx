import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import { MotionProvider } from "@/components/MotionProvider";
import { PerfProbeLoader } from "@/components/PerfProbeLoader";
import { SiteFooter } from "@/components/SiteFooter";
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

// The site's own address: link previews need an absolute URL for the picture (og:image), and metadataBase
// is what Next resolves it against. If the site moves, change it here. No og:url on purpose: it
// would name the home page on every page, and some sites then link a shared player page there.
const SITE_URL = "https://blunderprint.vercel.app";
const DESCRIPTION = "Find the recurring mistakes in your Chess.com or Lichess games.";

// The preview picture itself is app/opengraph-image.png (+ .alt.txt): Next adds its og:image and
// twitter:image tags by the file's name. It is made by `npm run og:image`.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Blunderprint",
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Blunderprint",
    title: "Blunderprint: your mistakes leave a print",
    description: DESCRIPTION,
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        <MotionProvider>{children}</MotionProvider>
        <SiteFooter />
        {/* Off unless the URL has ?perf=1 (then a small measuring box appears, bottom right). */}
        <PerfProbeLoader />
      </body>
    </html>
  );
}
