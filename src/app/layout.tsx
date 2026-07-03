import './globals.css';
import { AppShell } from '@/components/AppShell';

export const metadata = {
  title: 'UnifyCOI',
  description: 'Vendor COI compliance for multi-location self-storage operators',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
