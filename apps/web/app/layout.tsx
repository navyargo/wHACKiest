import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "CareRelay — no missed care", description: "Care coordination and failure prevention for families and caregivers." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
