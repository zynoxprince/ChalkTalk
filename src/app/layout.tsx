import type { Metadata, Viewport } from "next";
import { Caveat, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const caveat = Caveat({ variable: "--font-hand", subsets: ["latin"], weight: ["500", "600", "700"] });

export const metadata: Metadata = {
  title: "ChalkTalk — learn anything on a whiteboard",
  description:
    "An AI tutor that teaches any topic with a narrated, hand-drawn whiteboard lesson you can pause, rewind, and interrupt with questions.",
  openGraph: {
    title: "ChalkTalk — learn anything on a whiteboard",
    description: "Type a topic. Watch a 2-minute narrated whiteboard lesson. Raise your hand to ask anything.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#f7f5f0",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${caveat.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
