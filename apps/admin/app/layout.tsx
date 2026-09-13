import type { ReactNode } from 'react';

export const metadata = {
  title: 'IAxTi SuperAdmin',
  description: 'El CRM de WhatsApp que se arma solo y trabaja para el dueño.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-CL" data-mode="dia">
      <body>{children}</body>
    </html>
  );
}
