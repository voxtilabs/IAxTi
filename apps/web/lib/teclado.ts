/** No ejecutar atajos de una letra al escribir, componer texto o usar otro diálogo. */
export function estaEscribiendo(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]');
}
