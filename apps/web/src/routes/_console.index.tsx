import { createFileRoute } from '@tanstack/react-router';
import { ConsoleOverview } from '@/components/workstation/ConsoleOverview';

export const Route = createFileRoute('/_console/')({
  component: ConsoleOverview,
});
