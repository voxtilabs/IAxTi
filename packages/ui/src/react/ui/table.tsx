import * as React from 'react';
import { cn } from './cn';

// Primitivas semánticas del patrón table de shadcn, con tokens Pulso.
export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(({ className, ...props }, ref) =>
  <table ref={ref} className={cn('w-full table-fixed border-collapse text-dato', className)} {...props} />);
Table.displayName = 'Table';
export const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) =>
  <thead ref={ref} className={cn('border-b border-line-strong text-muted', className)} {...props} />);
TableHeader.displayName = 'TableHeader';
export const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) =>
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />);
TableBody.displayName = 'TableBody';
export const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(({ className, ...props }, ref) =>
  <tr ref={ref} className={cn('border-b border-line transition-colors hover:bg-rest data-[state=selected]:bg-action-soft', className)} {...props} />);
TableRow.displayName = 'TableRow';
export const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) =>
  <th ref={ref} className={cn('break-words px-fila-x py-fila-y text-left font-medium', className)} {...props} />);
TableHead.displayName = 'TableHead';
export const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) =>
  <td ref={ref} className={cn('break-words px-fila-x py-fila-y align-top', className)} {...props} />);
TableCell.displayName = 'TableCell';
