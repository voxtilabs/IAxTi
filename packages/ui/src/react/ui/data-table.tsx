'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type SortingState, type RowSelectionState } from '@tanstack/react-table';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

export type { ColumnDef, SortingState, RowSelectionState } from '@tanstack/react-table';

/** El servidor entrega una página ya ordenada/filtrada; aquí no se vuelve a ordenar. */
export function DataTable<T extends { id: string }>({ label, columns, rows, sorting, onSort, selection, onSelection,
  nextCursor, onNext, onPrevious, canPrevious, loading = false, mobileColumns, children,
}: {
  label: string; columns: ColumnDef<T, unknown>[]; rows: T[]; sorting: SortingState;
  onSort: (value: SortingState) => void; selection: RowSelectionState; onSelection: (value: RowSelectionState) => void;
  nextCursor: string | null; onNext: () => void; onPrevious: () => void; canPrevious: boolean;
  loading?: boolean; mobileColumns: string[]; children?: ReactNode;
}) {
  const [small, setSmall] = useState(false);
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const actualizar = () => setSmall(media.matches);
    actualizar(); media.addEventListener('change', actualizar);
    return () => media.removeEventListener('change', actualizar);
  }, []);
  const hidden = Object.fromEntries(columns.map((c) => [c.id!, small && !mobileColumns.includes(c.id!) ? false : visibility[c.id!] ?? true]));
  const table = useReactTable({
    data: rows, columns, getRowId: (row) => row.id, getCoreRowModel: getCoreRowModel(),
    manualSorting: true, manualFiltering: true, manualPagination: true, enableMultiSort: false, enableSortingRemoval: false,
    state: { sorting, rowSelection: selection, columnVisibility: hidden },
    onSortingChange: (updater) => onSort(typeof updater === 'function' ? updater(sorting) : updater),
  });
  const ids = rows.map((r) => r.id);
  const all = ids.length > 0 && ids.every((id) => selection[id]);
  return <div data-densidad="densa" className="mt-4 min-w-0 space-y-3" aria-busy={loading}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <details className="text-dato"><summary className="inline-flex min-h-control cursor-pointer items-center text-action-text">Columnas</summary>
        <div className="flex flex-wrap gap-3">{table.getAllLeafColumns().filter((c) => c.getCanHide()).map((c) => <label key={c.id} className="inline-flex min-h-control items-center gap-2">
          {/* El Checkbox de Pulso y no un `<input type="checkbox">`: el
              nativo se pinta con los colores del sistema operativo y en modo
              noche queda un cuadrado blanco. La guarda que prohíbe los nativos
              solo miraba apps/web, así que los tres de este archivo —el propio
              sistema de diseño— sobrevivieron (#537). */}
          <Checkbox checked={c.getIsVisible()} disabled={small && !mobileColumns.includes(c.id)} onCheckedChange={(v) => setVisibility((prev) => ({ ...prev, [c.id]: v === true }))} />
          {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}{small && !mobileColumns.includes(c.id) ? ' (pantalla amplia)' : ''}
        </label>)}</div>
      </details>
      <span className="text-dato text-muted"><span className="font-mono">{ids.filter((id) => selection[id]).length}</span> seleccionados en esta página</span>
    </div>
    {children}
    <div className="pulso-panel overflow-hidden rounded-tarjeta border border-line bg-raised">
      <Table aria-label={label}>
        <TableHeader><TableRow>
          <TableHead className="w-14 px-1"><label className="flex min-h-control items-center justify-center"><Checkbox aria-label="Seleccionar esta página" checked={all} disabled={loading || !rows.length} onCheckedChange={(v) => onSelection(v === true ? Object.fromEntries(ids.map((id) => [id, true])) : {})} /></label></TableHead>
          {table.getHeaderGroups()[0]?.headers.map((h) => <TableHead key={h.id} aria-sort={h.column.getIsSorted() === 'asc' ? 'ascending' : h.column.getIsSorted() === 'desc' ? 'descending' : undefined}>
            {h.column.getCanSort() ? <button type="button" disabled={loading} className="min-h-control w-full text-left text-action-text" onClick={h.column.getToggleSortingHandler()}>
              {flexRender(h.column.columnDef.header, h.getContext())}<span aria-hidden="true">{h.column.getIsSorted() === 'asc' ? ' ↑' : h.column.getIsSorted() === 'desc' ? ' ↓' : ''}</span>
            </button> : flexRender(h.column.columnDef.header, h.getContext())}
          </TableHead>)}
        </TableRow></TableHeader>
        <TableBody>{table.getRowModel().rows.map((r) => <TableRow key={r.id} data-state={selection[r.id] ? 'selected' : undefined}>
          <TableCell className="px-1"><label className="flex min-h-control items-center justify-center"><Checkbox aria-label={`Seleccionar fila ${r.index + 1}`} checked={!!selection[r.id]} disabled={loading} onCheckedChange={(v) => onSelection({ ...selection, [r.id]: v === true })} /></label></TableCell>
          {r.getVisibleCells().map((cell) => <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}
        </TableRow>)}</TableBody>
      </Table>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Button variant="secundario" disabled={loading || !canPrevious} onClick={onPrevious}>Anterior</Button>
      <span className="text-dato text-muted"><span className="font-mono">{rows.length}</span> filas</span>
      <Button variant="secundario" disabled={loading || !nextCursor} onClick={onNext}>Siguiente</Button>
    </div>
  </div>;
}
