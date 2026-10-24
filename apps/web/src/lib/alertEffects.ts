import type { Alert } from '@deltascan/shared';
import { ALERT_META } from './alertMeta';
import { marketData } from './marketData';
import { useUiStore } from '../store/uiStore';
import { fmtPrice } from './format';

const MIN_SOUND_GAP_MS = 350;

let ctx: AudioContext | null = null;
let lastSoundAt = 0;

/** Short synthesized chime — no audio assets needed, distinct per alert type. */
export function playTone(freqs: number[], volume: number): void {
  // Browsers block audio until the user has interacted with the page once.
  if (!navigator.userActivation?.hasBeenActive) return;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  const now = ctx.currentTime;
  freqs.forEach((freq, i) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    const start = now + i * 0.09;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.18 * volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(start);
    osc.stop(start + 0.25);
  });
}

function notify(alert: Alert): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const meta = ALERT_META[alert.type];
  new Notification(`${alert.symbol} · ${meta.label}`, {
    body: `${fmtPrice(alert.price)} — ${alert.detail}`,
    tag: `${alert.symbol}:${alert.type}`,
    silent: true,
  });
}

/** Subscribes once; plays sounds and raises desktop notifications for audible alert types. */
export function installAlertEffects(): void {
  marketData.onAlerts((added, reset) => {
    if (reset) return;
    const { settings } = useUiStore.getState();
    const audible = added.filter((a) => settings.audibleTypes.includes(a.type));
    if (!audible.length) return;

    const now = Date.now();
    if (settings.sound && now - lastSoundAt > MIN_SOUND_GAP_MS) {
      lastSoundAt = now;
      playTone(ALERT_META[audible[0]!.type].tone, settings.volume);
    }
    if (settings.notifications && document.hidden) audible.slice(0, 3).forEach(notify);
  });
}
