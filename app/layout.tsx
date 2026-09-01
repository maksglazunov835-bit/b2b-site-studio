import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'B2B Site Studio',
  description:
    'Админ-панель для генерации SEO-оптимизированных B2B-сайтов оптовых компаний.',
};

const assetRecoveryScript = `
(() => {
  const reloadKey = 'b2b-site-studio-asset-reload';
  const isBuildAsset = (value) => typeof value === 'string' && value.includes('/_next/static/');
  const reloadFresh = () => {
    if (sessionStorage.getItem(reloadKey) === '1') {
      return;
    }

    sessionStorage.setItem(reloadKey, '1');
    const url = new URL(window.location.href);
    url.searchParams.set('__fresh_assets', Date.now().toString());
    window.location.replace(url.toString());
  };

  window.addEventListener(
    'error',
    (event) => {
      const target = event.target;
      const source =
        target && 'href' in target
          ? target.href
          : target && 'src' in target
            ? target.src
            : event.filename;

      if (isBuildAsset(source)) {
        reloadFresh();
      }
    },
    true,
  );

  window.addEventListener('unhandledrejection', (event) => {
    const reason = String(event.reason?.message || event.reason || '');

    if (/chunk|import|module|asset|css/i.test(reason)) {
      reloadFresh();
    }
  });

  window.addEventListener('load', () => {
    sessionStorage.removeItem(reloadKey);
  });
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html className="dark" lang="ru">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <script dangerouslySetInnerHTML={{ __html: assetRecoveryScript }} />
        {children}
      </body>
    </html>
  );
}
