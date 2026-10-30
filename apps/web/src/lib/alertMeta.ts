import type { AlertType } from '@deltascan/shared';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ArrowDownRight,
  Blocks,
  ChevronsDown,
  CircleArrowDown,
  ChevronsUp,
  Flame,
  Pause,
  Play,
  TrendingDown,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react';

export interface AlertMeta {
  label: string;
  short: string;
  icon: LucideIcon;
  /** Tailwind text color class */
  text: string;
  /** Tailwind classes for a tinted badge */
  badge: string;
  /** Tone for audible alerts: frequencies played in sequence (Hz). */
  tone: number[];
}

export const ALERT_META: Record<AlertType, AlertMeta> = {
  new_high: {
    label: 'New High of Day',
    short: 'NHOD',
    icon: ArrowUpToLine,
    text: 'text-up',
    badge: 'bg-up/12 text-up ring-up/25',
    tone: [880, 1320],
  },
  new_low: {
    label: 'New Low of Day',
    short: 'NLOD',
    icon: ArrowDownToLine,
    text: 'text-down',
    badge: 'bg-down/12 text-down ring-down/25',
    tone: [660, 440],
  },
  vwap_reclaim: {
    label: 'VWAP Reclaim',
    short: 'VWAP ▲',
    icon: ChevronsUp,
    text: 'text-cyan',
    badge: 'bg-cyan/12 text-cyan ring-cyan/25',
    tone: [740, 988],
  },
  vwap_loss: {
    label: 'VWAP Loss',
    short: 'VWAP ▼',
    icon: ChevronsDown,
    text: 'text-violet',
    badge: 'bg-violet/12 text-violet ring-violet/25',
    tone: [622, 466],
  },
  volume_spike: {
    label: 'Volume Spike',
    short: 'VOL',
    icon: Flame,
    text: 'text-warn',
    badge: 'bg-warn/12 text-warn ring-warn/25',
    tone: [1046, 1046, 1318],
  },
  block_trade: {
    label: 'Block Trade',
    short: 'BLOCK',
    icon: Blocks,
    text: 'text-accent',
    badge: 'bg-accent/12 text-accent ring-accent/25',
    tone: [523, 784, 1046],
  },
  halt: {
    label: 'Trading Halt',
    short: 'HALT',
    icon: Pause,
    text: 'text-warn',
    badge: 'bg-warn/12 text-warn ring-warn/25',
    tone: [392, 392, 392],
  },
  topping: {
    label: 'Topping (starter)',
    short: 'TOPPING',
    icon: TriangleAlert,
    text: 'text-warn',
    badge: 'bg-warn/12 text-warn ring-warn/25',
    tone: [880, 660],
  },
  rejection_confirmed: {
    label: 'Rejection Confirmed',
    short: 'REJECT ✓',
    icon: TrendingDown,
    text: 'text-down',
    badge: 'bg-down/12 text-down ring-down/25',
    tone: [988, 740, 523],
  },
  vwap_break: {
    label: 'VWAP Break (add the rest)',
    short: 'VWAP BRK',
    icon: CircleArrowDown,
    text: 'text-down',
    badge: 'bg-down/20 text-down ring-down/40',
    tone: [988, 784, 587, 392],
  },
  failed_bounce: {
    label: 'Failed Bounce (lower high)',
    short: 'FAIL BNC',
    icon: ArrowDownRight,
    text: 'text-down',
    badge: 'bg-down/12 text-down ring-down/25',
    tone: [784, 587, 440],
  },
  vwap_bounce: {
    label: 'Backside VWAP Bounce',
    short: 'VWAP BNC',
    icon: Undo2,
    text: 'text-violet',
    badge: 'bg-violet/12 text-violet ring-violet/25',
    tone: [587, 784, 587],
  },
  resume: {
    label: 'Halt Resumed',
    short: 'RESUME',
    icon: Play,
    text: 'text-up',
    badge: 'bg-up/12 text-up ring-up/25',
    tone: [523, 659, 784],
  },
};
