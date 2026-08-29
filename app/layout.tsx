import type { Metadata } from 'next';
import { Geist, Geist_Mono, Noto_Serif_SC } from 'next/font/google';

import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
const notoSerifSC = Noto_Serif_SC({ variable: '--font-noto-serif-sc', subsets: ['latin'], weight: ['600', '700'] });

export const metadata: Metadata = {
  title: { default: 'LINSC · 超短情绪台', template: '%s' },
  description: '面向A股2—3日超短交易的静态情绪复盘报告库。',
  openGraph: {
    title: 'LINSC · 超短情绪台',
    description: '盘中看变化，盘后看结构。',
    images: [{ url: '/og.png', width: 1536, height: 1024, alt: 'LINSC超短情绪台' }],
  },
  twitter: { card: 'summary_large_image', images: ['/og.png'] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable} ${notoSerifSC.variable} antialiased`}>{children}</body>
    </html>
  );
}
