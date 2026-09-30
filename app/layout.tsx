import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/components/mentor/session";

export const metadata: Metadata = {
  title: "Mentor Portal",
  description: "Your groups, reports, credits and mentoring support in one place.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased"><SessionProvider>{children}</SessionProvider></body>
    </html>
  );
}
