export { SessionProvider, RequireSession, useSession } from './session';
export { EstadoVacio } from './estado-vacio';
export type { PublicConfig } from './session';
export { LoginCard } from './login-card';
export type { LoginCardProps } from './login-card';
export { ModeToggle } from './mode-toggle';
export { MARCA_LOCKUP_SVG, IAXTI_LOCKUP_SVG, IAXTI_ISOTIPO_SVG } from './marca-svg';
export { useMarcaSvg } from './use-marca-svg';
// Arrastrar y pegar un archivo (#561): el gesto, sin decidir cómo se ve.
export { useArrastre } from './use-arrastre';
export type { Arrastre, OpcionesDeArrastre } from './use-arrastre';

// Componentes shadcn-style tematizados con Pulso (sin hex, sin dark:).
export { cn } from './ui/cn';
export { Button } from './ui/button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './ui/button';
export { Input, Textarea } from './ui/input';
export { Badge } from './ui/badge';
export { Checkbox } from './ui/checkbox';
export { EncabezadoDePagina } from './ui/encabezado';
export type { EncabezadoDePaginaProps } from './ui/encabezado';
export type { BadgeProps, BadgeRole } from './ui/badge';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from './ui/dropdown-menu';
export { Avatar, iniciales } from './ui/avatar';
export type { AvatarProps } from './ui/avatar';
export { Skeleton } from './ui/skeleton';
export { Switch } from './ui/switch';
export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
export {
  IconoEnviar,
  IconoVolver,
  IconoCheck,
  IconoDobleCheck,
  IconoReloj,
  IconoX,
  IconoChevronAbajo,
  IconoPersona,
  IconoBandeja,
  IconoAlerta,
} from './ui/icons';
export { CanalChip, CanalIcono, nombreCanal, nombreVisible, NOMBRE_CANAL } from './canal';
export type { CanalId } from './canal';
export { AuditExplorer } from './audit-explorer';
export type { AuditFetcher, AuditRow, ChainCheckDto, SignedExportDto } from './audit-explorer';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
export * from './ui/table';
export * from './ui/data-table';

// La barra lateral (#295). Viene del registro de shadcn con dos retoques
// para Pulso, anotados en el propio archivo: fuera las sombras, y el borde
// del `outline` es un borde y no una sombra de 1 px con `hsl(var(…))`, que
// con tokens de color completo daba un color inválido.
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from './ui/sidebar';
export { Separator } from './ui/separator';

export { Avisos, AvisoResultado, toast } from './ui/avisos';
export { Command, CommandInput, CommandList, CommandItem, CommandGroup, CommandEmpty } from './ui/command';
// AI Elements del AI SDK de Vercel, tematizados Pulso (#493). Vienen del
// registro oficial: no están escritos acá, solo se les cambiaron los tokens.
export { Conversation, ConversationContent, ConversationScrollButton } from './ui/conversation';
export { Message, MessageContent } from './ui/message';
export { Loader } from './ui/loader';

export { MarcaJelly } from './marca-jelly';
// GraficoSeries NO sale por acá a propósito (#525): arrastra recharts, que son
// ~150 kB, y el barril lo mete en la primera carga de TODAS las pantallas. Se
// pide por `@iaxti/ui/react/grafico` y se carga diferido donde se usa.
// `GraficoCierre` sí: son dos círculos y un strokeDasharray, sin librería.
export { GraficoCierre } from './grafico-cierre';
export type { SerieGrafico } from './grafico-series';
