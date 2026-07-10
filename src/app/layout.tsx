import './globals.css';
import { Manrope } from 'next/font/google';
import { AppShell } from '@/components/AppShell';

// Self-hosted at build (no runtime CDN → no CSP/offline-runtime issue). Exposed as a CSS var
// only; design-system surfaces opt in via `font-sans`. The tenant app keeps its own inline
// font until the Slice 9 retrofit (additive, no disturbance).
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-manrope',
  display: 'swap',
});

export const metadata = {
  title: 'UnifyCOI',
  description: 'Vendor COI compliance for multi-location self-storage operators',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body style={{ margin: 0 }}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
