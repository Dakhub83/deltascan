import type { AlertType } from '@scanner/shared';
import { ArrowDownToLine, ArrowUpToLine, Blocks, ChevronsDown, ChevronsUp, Flame, type LucideIcon } from 'lucide-react';

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
};
