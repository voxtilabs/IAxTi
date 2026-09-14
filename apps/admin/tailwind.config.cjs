/** Config mínima: todo el sistema vive en el preset de Pulso (@iaxti/ui). */
module.exports = {
  presets: [require('@iaxti/ui/tailwind-preset')],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../../packages/ui/src/react/**/*.{ts,tsx}',
  ],
};
