'use client';

import * as React from 'react';
import { Command as Primitive } from 'cmdk';
import { cn } from './cn';

// Patrón command de shadcn: cmdk aporta teclado/ARIA, Pulso aporta los tokens.
export const Command = React.forwardRef<React.ElementRef<typeof Primitive>, React.ComponentPropsWithoutRef<typeof Primitive>>(({ className, ...props }, ref) =>
  <Primitive ref={ref} className={cn('flex min-w-0 flex-col overflow-hidden bg-raised text-ink', className)} {...props} />);
Command.displayName = 'Command';
export const CommandInput = React.forwardRef<React.ElementRef<typeof Primitive.Input>, React.ComponentPropsWithoutRef<typeof Primitive.Input>>(({ className, ...props }, ref) =>
  <Primitive.Input ref={ref} className={cn('h-control w-full rounded-campo border border-line-strong bg-field px-4 text-cuerpo text-ink placeholder:text-faint', className)} {...props} />);
CommandInput.displayName = 'CommandInput';
export const CommandList = React.forwardRef<React.ElementRef<typeof Primitive.List>, React.ComponentPropsWithoutRef<typeof Primitive.List>>(({ className, ...props }, ref) =>
  <Primitive.List ref={ref} className={cn('max-h-80 overflow-y-auto p-1', className)} {...props} />);
CommandList.displayName = 'CommandList';
export const CommandItem = React.forwardRef<React.ElementRef<typeof Primitive.Item>, React.ComponentPropsWithoutRef<typeof Primitive.Item>>(({ className, ...props }, ref) =>
  <Primitive.Item ref={ref} className={cn('flex min-h-control cursor-pointer items-center gap-3 rounded-campo px-3 py-2 text-dato data-[selected=true]:bg-action-soft data-[selected=true]:text-action-text data-[disabled=true]:opacity-50', className)} {...props} />);
CommandItem.displayName = 'CommandItem';
export const CommandGroup = React.forwardRef<React.ElementRef<typeof Primitive.Group>, React.ComponentPropsWithoutRef<typeof Primitive.Group>>(({ className, ...props }, ref) =>
  <Primitive.Group ref={ref} className={cn('py-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-rotulo [&_[cmdk-group-heading]]:text-muted', className)} {...props} />);
CommandGroup.displayName = 'CommandGroup';
export const CommandEmpty = Primitive.Empty;
