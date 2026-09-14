import type { ReactNode } from 'react';
import { MODE_INIT_SCRIPT } from '@iaxti/ui';
import '@iaxti/ui/pulso-tokens.css';
import '@iaxti/ui/pulso-base.css';

export const metadata = {
  title: 'IAxTi SuperAdmin',
  description: 'Panel de operación de la plataforma IAxTi.',
  icons: { icon: '/marca/voxti-isotipo-cuadrado.svg' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: data-mode lo fija el script ANTES del render
    // según prefers-color-scheme o la elección guardada (Pulso §11).
    <html lang="es-CL" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: MODE_INIT_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700;800&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
