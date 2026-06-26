export const metadata = {
  title: 'UnifyCOI',
  description: 'Vendor COI compliance for multi-location self-storage operators',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
