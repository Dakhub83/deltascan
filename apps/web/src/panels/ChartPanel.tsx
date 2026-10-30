import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { AlertType, Bar, FadeState } from '@deltascan/shared';
import { ChartCandlestick, Link2, Link2Off } from 'lucide-react';
import clsx from 'clsx';
import { marketData } from '../lib/marketData';
import { TIMEFRAMES, aggregate, ema, sessionVwap, timeframeLabel, upsertBar, type Timeframe } from '../lib/chartData';
import { fadeLevels, signalMarks, type LevelKind } from '../lib/fadeSignals';
import { fmtCompact, fmtPct, fmtPrice } from '../lib/format';
import { requestLayoutSave } from '../lib/layout';
import { useUiStore } from '../store/uiStore';
import { STAGE_META } from '../scanners/fade';

export interface ChartPanelParams {
  /** Symbol shown when not linked to the selection. */
  symbol?: string | null;
  /** Follow the symbol selected in scanners and alerts (default). */
  linked?: boolean;
  timeframe?: Timeframe;
  extendedHours?: boolean;
  indicators?: Partial<Record<IndicatorId, boolean>>;
}

type IndicatorId = 'vwap' | 'ema9' | 'ema20' | 'volume';

const INDICATORS: { id: IndicatorId; label: string; color: string }[] = [
  { id: 'vwap', label: 'VWAP', color: '#f5a524' },
  { id: 'ema9', label: 'EMA 9', color: '#22d3ee' },
  { id: 'ema20', label: 'EMA 20', color: '#a78bfa' },
  { id: 'volume', label: 'Vol', color: '#6b7587' },
];
const DEFAULT_INDICATORS: Record<IndicatorId, boolean> = { vwap: true, ema9: true, ema20: false, volume: true };

const UP = '#16c784';
const DOWN = '#f0464f';
/** Extended-hours candles are drawn faded, as in thinkorswim / TradingView. */
const EXT_ALPHA = '66';
const HIDDEN = 'rgba(0,0,0,0)';

const LEVEL_STYLE: Record<LevelKind, { color: string; style: LineStyle }> = {
  hod: { color: '#6b7587', style: LineStyle.Dashed },
  risk: { color: '#f5a524', style: LineStyle.Dashed },
  trigger: { color: DOWN, style: LineStyle.Dotted },
  confirmed: { color: DOWN, style: LineStyle.Solid },
  lowerHigh: { color: '#f472b6', style: LineStyle.Dashed },
};

const MARK_STYLE: Partial<Record<AlertType, { color: string; text: string }>> = {
  topping: { color: '#f5a524', text: 'TOP' },
  rejection_confirmed: { color: DOWN, text: 'CONF' },
  failed_bounce: { color: '#f472b6', text: 'LH' },
  vwap_bounce: { color: '#a78bfa', text: 'VWAP' },
};

/** Stage hints for a short seller sizing in: start small on topping, add on confirmation. */
const STAGE_HINT: Partial<Record<FadeState['stage'], string>> = {
  extension: 'Extended above VWAP and making highs: watch for a topping tail or a failed new high.',
  rejection: 'Topping: starter size. Risk is a new high over RISK; add on a close under CONFIRMS.',
  confirmation: 'Rejection confirmed: the add. Risk stays over the rejection high.',
  fade: 'On the back side: do not chase. Add when a bounce makes a lower high and rolls over (LH), risk over that high.',
  'vwap-bounce': 'Bounced into VWAP from below: backside add if it fails here.',
};

const toTime = (ms: number) => (ms / 1000) as UTCTimestamp;
const etFmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts });
const etTime = etFmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const etDay = etFmt({ month: 'short', day: 'numeric' });
const etFull = etFmt({ weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

interface Series {
  candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
  vwap: ISeriesApi<'Line'>;
  ema9: ISeriesApi<'Line'>;
  ema20: ISeriesApi<'Line'>;
}

interface Legend {
  bar: Bar;
  prevClose: number | null;
  values: Partial<Record<IndicatorId, number | null>>;
}

function candleColors(b: Bar) {
  const color = (b.close >= b.open ? UP : DOWN) + (b.session && b.session !== 'regular' ? EXT_ALPHA : '');
  return { color, borderColor: color, wickColor: color };
}

function createChartIn(container: HTMLElement): { chart: IChartApi; series: Series } {
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: '#0c1017' },
      textColor: '#6b7587',
      fontSize: 11,
      fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
    },
    grid: { vertLines: { color: '#141b26' }, horzLines: { color: '#141b26' } },
    rightPriceScale: { borderColor: '#1c2431' },
    timeScale: {
      borderColor: '#1c2431',
      timeVisible: true,
      rightOffset: 6,
      tickMarkFormatter: (time: Time, type: TickMarkType) => {
        const ms = (time as number) * 1000;
        return type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds ? etTime.format(ms) : etDay.format(ms);
      },
    },
    localization: { timeFormatter: (time: Time) => `${etFull.format((time as number) * 1000)} ET` },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#3d8bfd66', labelBackgroundColor: '#283244' },
      horzLine: { color: '#3d8bfd66', labelBackgroundColor: '#283244' },
    },
  });
  const line = (color: string) =>
    chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const series: Series = {
    candles: chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN }),
    volume: chart.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }),
    vwap: line('#f5a524'),
    ema9: line('#22d3ee'),
    ema20: line('#a78bfa'),
  };
  series.vwap.applyOptions({ lineStyle: LineStyle.Solid, lineWidth: 2 });
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  return { chart, series };
}

export function ChartPanel({ params, api: panelApi }: IDockviewPanelProps<ChartPanelParams>) {
  const linked = params.linked ?? true;
  const selected = useUiStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const symbol = (linked ? selected : params.symbol) ?? null;
  const timeframe = params.timeframe ?? 5;
  const extendedHours = params.extendedHours ?? true;
  const indicators = { ...DEFAULT_INDICATORS, ...params.indicators };

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{ chart: IChartApi; series: Series } | null>(null);
  const minuteBars = useRef<Bar[]>([]);
  const shown = useRef<{ bars: Bar[]; vwap: (number | null)[]; vwapStarts: boolean[]; ema9: (number | null)[]; ema20: (number | null)[] }>({
    bars: [],
    vwap: [],
    vwapStarts: [],
    ema9: [],
    ema20: [],
  });
  const hovering = useRef(false);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const levelLines = useRef<IPriceLine[]>([]);
  const [fade, setFade] = useState<FadeState | null>(null);
  // Read by `render`, which the long-lived live-bar callback also calls.
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const settings = useRef({ timeframe, extendedHours });
  settings.current = { timeframe, extendedHours };
  const [legend, setLegend] = useState<Legend | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [draft, setDraft] = useState('');

  const update = (patch: Partial<ChartPanelParams>) => {
    panelApi.updateParameters(patch);
    requestLayoutSave();
  };

  useEffect(() => {
    panelApi.setTitle(symbol ? `${symbol} · ${timeframeLabel(timeframe)}` : 'Chart');
  }, [panelApi, symbol, timeframe]);

  // The chart lives for the panel's lifetime; data effects below drive it.
  useEffect(() => {
    if (!containerRef.current) return;
    const created = createChartIn(containerRef.current);
    chartRef.current = created;
    markers.current = createSeriesMarkers(created.series.candles, []);
    const onMove = (p: MouseEventParams<Time>) => {
      const i = p.logical === undefined ? -1 : Math.round(p.logical);
      hovering.current = p.point !== undefined && i >= 0 && i < shown.current.bars.length;
      setLegend(hovering.current ? legendAt(i) : latestLegend());
    };
    created.chart.subscribeCrosshairMove(onMove);
    return () => {
      created.chart.unsubscribeCrosshairMove(onMove);
      created.chart.remove();
      chartRef.current = null;
      markers.current = null;
      levelLines.current = [];
    };
  }, []);

  const legendAt = (i: number): Legend | null => {
    const s = shown.current;
    const bar = s.bars[i];
    if (!bar) return null;
    return {
      bar,
      prevClose: s.bars[i - 1]?.close ?? null,
      values: { vwap: s.vwap[i] ?? null, ema9: s.ema9[i] ?? null, ema20: s.ema20[i] ?? null, volume: bar.volume },
    };
  };
  const latestLegend = () => legendAt(shown.current.bars.length - 1);

  /** Short-side signals from the alert feed, on the bars that produced them. */
  const drawSignals = () => {
    const sym = symbolRef.current;
    if (!markers.current) return;
    const times = shown.current.bars.map((b) => b.timestamp);
    const marks: SeriesMarker<Time>[] = sym
      ? signalMarks(marketData.alerts, sym, times).map((m) => {
          const st = MARK_STYLE[m.type]!;
          return { time: toTime(m.barTime), position: 'aboveBar', shape: 'arrowDown', color: st.color, text: st.text };
        })
      : [];
    markers.current.setMarkers(marks);
  };

  /** Recomputes the displayed bars and indicators; `full` redraws everything, otherwise only the last point. */
  const render = (full: boolean) => {
    const c = chartRef.current;
    if (!c) return;
    const bars = aggregate(minuteBars.current, settings.current.timeframe, settings.current.extendedHours);
    const { values: vwap, starts: vwapStarts } = sessionVwap(bars);
    const ema9 = ema(bars, 9);
    const ema20 = ema(bars, 20);
    shown.current = { bars, vwap, vwapStarts, ema9, ema20 };

    const candle = (b: Bar) => ({ time: toTime(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close, ...candleColors(b) });
    const vol = (b: Bar) => ({ time: toTime(b.timestamp), value: b.volume, color: (b.close >= b.open ? UP : DOWN) + '55' });
    const point = (b: Bar, v: number | null) => (v === null ? { time: toTime(b.timestamp) } : { time: toTime(b.timestamp), value: v });
    // Lines join across empty points, and a segment takes its starting point's color. So VWAP
    // breaks are drawn as hidden points, and the last point before a break is hidden too.
    let carried: number | null = null;
    const vwapPoint = (b: Bar, i: number) => {
      const v = vwap[i] ?? null;
      const time = toTime(b.timestamp);
      if (v === null) return carried === null ? { time } : { time, value: carried, color: HIDDEN };
      carried = v;
      const breaksAfter = i + 1 < bars.length && (vwap[i + 1] === null || vwapStarts[i + 1]);
      return breaksAfter ? { time, value: v, color: HIDDEN } : { time, value: v };
    };

    if (full) {
      c.series.candles.setData(bars.map(candle));
      c.series.volume.setData(bars.map(vol));
      c.series.vwap.setData(bars.map(vwapPoint));
      c.series.ema9.setData(bars.map((b, i) => point(b, ema9[i]!)));
      c.series.ema20.setData(bars.map((b, i) => point(b, ema20[i]!)));
      // Default bar width scrolled to now, so resizing the window shows more or fewer bars.
      c.chart.timeScale().resetTimeScale();
    } else {
      const i = bars.length - 1;
      const b = bars[i];
      if (!b) return;
      c.series.candles.update(candle(b));
      c.series.volume.update(vol(b));
      carried = vwap.slice(0, i).reverse().find((v) => v !== null) ?? null;
      c.series.vwap.update(vwapPoint(b, i));
      c.series.ema9.update(point(b, ema9[i]!));
      c.series.ema20.update(point(b, ema20[i]!));
    }
    if (full) drawSignals();
    if (!hovering.current) setLegend(latestLegend());
  };

  // Load history and stream the live bar. Live bars that arrive before the history are kept.
  useEffect(() => {
    minuteBars.current = [];
    setLegend(null);
    if (!symbol) {
      setStatus('idle');
      render(true);
      return;
    }
    let cancelled = false;
    let loaded = false;
    setStatus('loading');
    const off = marketData.onBars(symbol, (bar) => {
      upsertBar(minuteBars.current, bar);
      if (loaded) render(false);
    });
    marketData
      .fetchBars(symbol)
      .then((history) => {
        if (cancelled) return;
        const lastHistoric = history[history.length - 1]?.timestamp ?? -Infinity;
        minuteBars.current = [...history, ...minuteBars.current.filter((b) => b.timestamp > lastHistoric)];
        loaded = true;
        setStatus(minuteBars.current.length ? 'ready' : 'empty');
        render(true);
      })
      .catch(() => !cancelled && setStatus('error'));
    return () => {
      cancelled = true;
      off();
    };
  }, [symbol]);

  // The setup stage comes with the symbol's snapshot; new signals arrive on the alert feed.
  useEffect(() => {
    setFade(symbol ? (marketData.rows.get(symbol)?.fade ?? null) : null);
    if (!symbol) return;
    const offRows = marketData.onRows((changed, reset) => {
      const row = reset ? marketData.rows.get(symbol) : changed.find((r) => r.symbol === symbol);
      if (row || reset) setFade(row?.fade ?? null);
    });
    const offAlerts = marketData.onAlerts((added, reset) => {
      if (reset || added.some((a) => a.symbol === symbol)) drawSignals();
    });
    return () => {
      offRows();
      offAlerts();
    };
  }, [symbol]);

  useEffect(() => {
    const candles = chartRef.current?.series.candles;
    if (!candles) return;
    levelLines.current.forEach((l) => candles.removePriceLine(l));
    levelLines.current = fadeLevels(fade).map((l) =>
      candles.createPriceLine({ price: l.price, title: l.title, color: LEVEL_STYLE[l.kind].color, lineStyle: LEVEL_STYLE[l.kind].style, lineWidth: 1, axisLabelVisible: true }),
    );
  }, [fade]);

  // Timeframe / session filter changes re-aggregate what's already loaded.
  useEffect(() => {
    if (minuteBars.current.length) render(true);
  }, [timeframe, extendedHours]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    c.series.vwap.applyOptions({ visible: indicators.vwap });
    c.series.ema9.applyOptions({ visible: indicators.ema9 });
    c.series.ema20.applyOptions({ visible: indicators.ema20 });
    c.series.volume.applyOptions({ visible: indicators.volume });
  }, [indicators.vwap, indicators.ema9, indicators.ema20, indicators.volume]);

  const submitSymbol = (e: FormEvent) => {
    e.preventDefault();
    const sym = draft.trim().toUpperCase();
    setDraft('');
    if (!sym) return;
    if (linked) setSelectedSymbol(sym);
    else update({ symbol: sym });
  };

  const toggleLink = () => (linked ? update({ linked: false, symbol }) : update({ linked: true }));

  const bar = legend?.bar;
  const barChange = bar && legend.prevClose ? ((bar.close - legend.prevClose) / legend.prevClose) * 100 : null;

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <form onSubmit={submitSymbol}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={symbol ?? 'Symbol'}
            aria-label="Chart symbol"
            maxLength={10}
            className="h-6 w-20 rounded-md border border-line bg-bg px-2 text-[12px] font-semibold text-fg uppercase outline-none placeholder:font-semibold placeholder:text-fg placeholder:normal-case focus:border-accent/60 focus:placeholder:text-muted"
          />
        </form>
        <button
          type="button"
          onClick={toggleLink}
          title={linked ? 'Linked to the selected symbol. Click to pin this chart to its symbol.' : 'Pinned. Click to follow the selected symbol.'}
          aria-label={linked ? 'Unlink chart from selection' : 'Link chart to selection'}
          className={clsx('grid size-6 place-items-center rounded-md transition-colors hover:bg-hover', linked ? 'text-accent' : 'text-muted hover:text-fg')}
        >
          {linked ? <Link2 className="size-3.5" /> : <Link2Off className="size-3.5" />}
        </button>

        <div className="mx-1 h-4 w-px bg-line" />
        <div className="flex items-center rounded-md bg-bg p-0.5 ring-1 ring-line">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => update({ timeframe: tf })}
              className={clsx('num rounded px-1.5 py-px text-[11px] font-medium transition-colors', tf === timeframe ? 'bg-accent/20 text-fg' : 'text-muted hover:text-fg')}
            >
              {timeframeLabel(tf)}
            </button>
          ))}
        </div>

        <div className="mx-1 h-4 w-px bg-line" />
        {INDICATORS.map((ind) => (
          <button
            key={ind.id}
            type="button"
            onClick={() => update({ indicators: { ...params.indicators, [ind.id]: !indicators[ind.id] } })}
            className={clsx('rounded px-1.5 py-px text-[11px] font-medium transition-colors', indicators[ind.id] ? 'text-fg' : 'text-muted/60 hover:text-dim')}
            style={indicators[ind.id] ? { boxShadow: `inset 0 -2px 0 ${ind.color}` } : undefined}
          >
            {ind.label}
          </button>
        ))}
        {fade && fade.stage !== 'spike' && (
          <span
            title={STAGE_HINT[fade.stage]}
            className={clsx('ml-auto rounded px-1.5 py-px text-[10px] font-semibold tracking-wide ring-1', STAGE_META[fade.stage].badge)}
          >
            {fade.stage === 'rejection' ? 'TOPPING · STARTER' : STAGE_META[fade.stage].label}
          </span>
        )}
        <button
          type="button"
          onClick={() => update({ extendedHours: !extendedHours })}
          title="Show pre-market and after-hours bars"
          className={clsx('rounded px-1.5 py-px text-[11px] font-medium transition-colors', !(fade && fade.stage !== 'spike') && 'ml-auto', extendedHours ? 'bg-violet/15 text-violet' : 'text-muted hover:text-dim')}
        >
          Ext hrs
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        {bar && symbol && (
          <div className="num pointer-events-none absolute top-1.5 left-2 z-10 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]">
            <span className="font-sans text-[12px] font-semibold text-fg">{symbol}</span>
            <span className="text-muted">{timeframeLabel(timeframe)}</span>
            {(['open', 'high', 'low', 'close'] as const).map((k) => (
              <span key={k} className="text-muted">
                {k[0]!.toUpperCase()} <span className={bar.close >= bar.open ? 'text-up' : 'text-down'}>{fmtPrice(bar[k])}</span>
              </span>
            ))}
            {barChange !== null && <span className={barChange >= 0 ? 'text-up' : 'text-down'}>{fmtPct(barChange)}</span>}
            {bar.session && bar.session !== 'regular' && (
              <span className="rounded bg-violet/15 px-1 text-[10px] font-semibold text-violet">{bar.session === 'pre' ? 'PRE' : 'AH'}</span>
            )}
            <span className="basis-full" />
            {INDICATORS.filter((ind) => indicators[ind.id] && legend.values[ind.id] != null).map((ind) => (
              <span key={ind.id} className="text-muted">
                {ind.label}{' '}
                <span style={{ color: ind.id === 'volume' ? undefined : ind.color }} className={ind.id === 'volume' ? 'text-dim' : undefined}>
                  {ind.id === 'volume' ? fmtCompact(legend.values.volume!) : fmtPrice(legend.values[ind.id]!)}
                </span>
              </span>
            ))}
          </div>
        )}

        {status !== 'ready' && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-panel">
            <div className="flex flex-col items-center gap-2 text-center">
              <ChartCandlestick className="size-6 text-muted/60" />
              <span className="text-[12px] text-muted">
                {status === 'idle' && 'Select a symbol in any scanner, or type one above.'}
                {status === 'loading' && `Loading ${symbol}…`}
                {status === 'empty' && `No bars for ${symbol} yet.`}
                {status === 'error' && `Couldn't load ${symbol}. Is the server running?`}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
