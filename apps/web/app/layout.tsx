import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "CareRelay — no missed care", description: "Care coordination and failure prevention for families and caregivers." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-teal-900 focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-teal-900"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
