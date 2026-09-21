import type { ReactNode } from 'react';
import { Avisos } from '@iaxti/ui/react';
import { MODE_INIT_SCRIPT } from '@iaxti/ui';
import '@iaxti/ui/pulso-tokens.css';
// El puente entre shadcn y Pulso (#291). Existía desde entonces y no lo
// importaba nadie: las variables que usan los componentes del registro
// —`--background`, `--popover`, `--accent`— quedaban SIN DEFINIR, así que
// cada uno pintaba con lo que heredara. Se notó al traer la barra lateral
// (#295), cuyo estado activo simplemente no se veía.
import '@iaxti/ui/shadcn-puente.css';
import '@iaxti/ui/pulso-base.css';
import './globals.css';
import '@iaxti/ui/pulso-vivo.css';

export const metadata = {
  title: 'IAxTi',
  description: 'El CRM de WhatsApp que se arma solo y trabaja para el dueño.',
  // El favicon es de IAxTi, que es lo que el cliente abre. El de VoxTi
  // Labs se queda en el panel de SuperAdmin, que es de nosotros.
  //
  // Va como ARCHIVO y no con las variables de Pulso: fuera del documento no
  // hay CSS, así que el isotipo lleva su color. Por eso existen las dos
  // versiones — la tokenizada para inline, esta para el favicon.
  icons: { icon: '/marca/iaxti-isotipo-cuadrado.svg' },
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
      <body>{children}<Avisos /></body>
    </html>
  );
}
