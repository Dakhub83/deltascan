import type { ReactNode } from 'react';
import {
  ArrowRight,
  BellRing,
  ChartCandlestick,
  CircleArrowDown,
  ChevronsDown,
  Crosshair,
  FileSearch,
  Radar,
  SlidersHorizontal,
  TrendingDown,
  TriangleAlert,
  ArrowDownRight,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';

const APP_URL = '/app/';

function Logo() {
  return (
    <a href="/" className="flex items-center gap-2" aria-label="DeltaScan home">
      <span className="grid size-8 place-items-center rounded-lg bg-accent/15 ring-1 ring-accent/30 ring-inset">
        <Radar className="size-4 text-accent" />
      </span>
      <span className="text-[16px] font-semibold tracking-tight">
        Delta<span className="text-accent">Scan</span>
      </span>
    </a>
  );
}

function LaunchButton({ size = 'md', className }: { size?: 'md' | 'lg'; className?: string }) {
  return (
    <a
      href={APP_URL}
      className={clsx(
        'group inline-flex items-center justify-center gap-2 rounded-lg bg-accent font-semibold text-white shadow-lg shadow-accent/20 transition-colors hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        size === 'lg' ? 'h-12 px-6 text-[15px]' : 'h-9 px-4 text-[13px]',
        className,
      )}
    >
      Launch app
      <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
    </a>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-4 sm:px-6">
        <Logo />
        <nav className="hidden items-center gap-6 text-[13px] text-dim md:flex">
          <a href="#features" className="hover:text-fg">Features</a>
          <a href="#signals" className="hover:text-fg">Short signals</a>
          <a href="#how" className="hover:text-fg">How it works</a>
        </nav>
        <LaunchButton className="ml-auto" />
      </div>
    </header>
  );
}

/** The real short-side alert chips, in the order a setup matures. */
const LADDER: { label: string; icon: LucideIcon; badge: string; title: string; text: string }[] = [
  {
    label: 'TOPPING',
    icon: TriangleAlert,
    badge: 'bg-down/12 text-down ring-down/30',
    title: 'The run stalls',
    text: 'A topping tail, a reversal candle at the high, or a gap-and-fail. Your starter size.',
  },
  {
    label: '→ VWAP',
    icon: ChevronsDown,
    badge: 'bg-down/16 text-down ring-down/40',
    title: 'Fading into VWAP',
    text: 'Topped, weakening and closing in on VWAP. Get ready for the break.',
  },
  {
    label: 'VWAP BRK',
    icon: CircleArrowDown,
    badge: 'bg-down/24 text-down ring-down/60 font-bold',
    title: 'VWAP breaks',
    text: 'The first 1-minute close under VWAP after the top. Where the rest of the size goes in.',
  },
  {
    label: 'FAIL BNC',
    icon: ArrowDownRight,
    badge: 'bg-down/24 text-down ring-down/60 font-bold',
    title: 'The bounce fails',
    text: 'A lower high under the top, then a break of the prior low. The backside is confirmed.',
  },
  {
    label: 'SHORT',
    icon: TrendingDown,
    badge: 'bg-down text-white ring-down font-extrabold',
    title: 'Backside short',
    text: 'One clear signal per setup, with the stop at the lower high drawn on the chart.',
  },
];

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Radar,
    title: 'Whole-market radar',
    text: 'Every stock’s 1-minute bars are watched. A name that starts running shows up within about a minute, before it hits any gainers list.',
  },
  {
    icon: TrendingDown,
    title: 'Short-side signal ladder',
    text: 'Spike, extension, rejection, confirmation, fade. Each stage is tracked on completed bars and alerted once, with the risk level.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Scanners you can tune',
    text: '20 built-in scans, from Gap Ups to RSI Overbought Runners. Narrow any window by price, float, RSI, EMA 9/20 cross and relative volume.',
  },
  {
    icon: BellRing,
    title: 'Instant alerts',
    text: 'New highs, VWAP crosses, volume spikes, halts and every short signal, with sounds per alert type and a repeating new-highs feed.',
  },
  {
    icon: ChartCandlestick,
    title: 'Charts with the setup drawn',
    text: 'High of day, rejection high, VWAP and the short’s risk line plotted on the chart, with every signal marked where it fired.',
  },
  {
    icon: FileSearch,
    title: 'Dilution tracker',
    text: 'Shelf registrations, offerings, reverse splits and cash runway read from SEC filings, so you know who is selling into the run.',
  },
];

const STEPS: { title: string; text: string }[] = [
  { title: 'The radar finds the runner', text: 'Gap-ups and sudden movers land in your scanner windows, ranked and filtered your way.' },
  { title: 'The ladder tracks the setup', text: 'TOPPING, → VWAP, VWAP BRK, FAIL BNC, SHORT: each fires once, as the chart confirms it.' },
  { title: 'You size in on your plan', text: 'A starter on the top, the rest on the VWAP break. The short calculator works out shares and risk.' },
];

function Section({ id, eyebrow, title, intro, children }: { id: string; eyebrow: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-line/60 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p className="text-[12px] font-semibold tracking-[0.14em] text-accent uppercase">{eyebrow}</p>
        <h2 className="mt-3 max-w-2xl text-[28px] leading-tight font-semibold tracking-tight text-balance sm:text-[34px]">{title}</h2>
        {intro && <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-dim">{intro}</p>}
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

export function Landing() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <Nav />

      <main>
        {/* Hero */}
        <section className="relative">
          <div className="hero-grid pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative mx-auto max-w-6xl px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-24">
            <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-line-strong bg-panel/80 px-3 py-1 text-[12px] text-dim">
              <span className="size-1.5 rounded-full bg-up" aria-hidden />
              Real-time scanner for short sellers
            </p>
            <h1 className="mx-auto mt-6 max-w-3xl text-[38px] leading-[1.08] font-semibold tracking-tight text-balance sm:text-[56px]">
              Catch the <span className="whitespace-nowrap">gap-up</span> <span className="text-down">before it fades.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-[16px] leading-relaxed text-pretty text-dim sm:text-[17px]">
              DeltaScan watches the whole market, finds the stocks that are running, and tells you the moment they top, break VWAP
              and roll over, so you can short the backside on your plan instead of chasing it.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <LaunchButton size="lg" />
              <a
                href="#signals"
                className="inline-flex h-12 items-center gap-2 rounded-lg border border-line-strong px-6 text-[15px] font-medium text-fg transition-colors hover:bg-raised"
              >
                See the signals
              </a>
            </div>
          </div>

          <div className="relative mx-auto max-w-6xl px-4 pb-20 sm:px-6">
            <div className="hero-glow pointer-events-none absolute inset-x-0 -top-10 bottom-0" aria-hidden />
            <div className="relative overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/60">
              <div className="flex h-8 items-center gap-1.5 border-b border-line px-3" aria-hidden>
                <span className="size-2.5 rounded-full bg-line-strong" />
                <span className="size-2.5 rounded-full bg-line-strong" />
                <span className="size-2.5 rounded-full bg-line-strong" />
              </div>
              <img
                src="/landing/dashboard.png"
                alt="The DeltaScan dashboard: scanner windows, an alert feed with short signals, and a chart"
                width={1600}
                height={900}
                className="block h-auto w-full"
              />
            </div>
            <p className="mt-3 text-center text-[12px] text-muted">Shown with simulated market data.</p>
          </div>
        </section>

        <Section
          id="features"
          eyebrow="Features"
          title="Everything a fade trader watches, in one window"
          intro="Scanning runs on the server, so the browser only draws. Hundreds of updates a second stay smooth, and every window is yours to arrange and save."
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <article key={f.title} className="rounded-xl border border-line bg-panel p-6 transition-colors hover:border-line-strong">
                <span className="grid size-10 place-items-center rounded-lg bg-accent/12 text-accent ring-1 ring-accent/25 ring-inset">
                  <f.icon className="size-5" />
                </span>
                <h3 className="mt-5 text-[16px] font-semibold">{f.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-dim">{f.text}</p>
              </article>
            ))}
          </div>
        </Section>

        <Section
          id="signals"
          eyebrow="Short signals"
          title="From the first crack to the backside short"
          intro="Each signal fires once per setup, on completed 1-minute bars. The colour gets stronger as the setup matures, so the one to act on stands out in a busy feed."
        >
          <ol className="grid gap-3 lg:grid-cols-5">
            {LADDER.map((step, i) => (
              <li key={step.label} className="relative rounded-xl border border-line bg-panel p-5">
                <div className="flex items-center justify-between">
                  <span className={clsx('inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide ring-1 ring-inset', step.badge)}>
                    <step.icon className="size-3.5" strokeWidth={2.5} />
                    {step.label}
                  </span>
                  <span className="num text-[12px] text-muted">{String(i + 1).padStart(2, '0')}</span>
                </div>
                <h3 className="mt-4 text-[15px] font-semibold">{step.title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-dim">{step.text}</p>
              </li>
            ))}
          </ol>
        </Section>

        <Section id="how" eyebrow="How it works" title="Built around one plan: start small, add on the break">
          <ol className="grid gap-4 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-4 rounded-xl border border-line bg-panel p-6">
                <span className="num grid size-8 shrink-0 place-items-center rounded-full bg-raised text-[13px] font-semibold text-accent ring-1 ring-line-strong">
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-[15px] font-semibold">{s.title}</h3>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-dim">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <section className="border-t border-line/60 py-20 sm:py-24">
          <div className="mx-auto max-w-4xl px-4 text-center sm:px-6">
            <Crosshair className="mx-auto size-8 text-accent" />
            <h2 className="mt-5 text-[28px] leading-tight font-semibold tracking-tight text-balance sm:text-[36px]">Your next setup is already forming.</h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-dim">Open the scanner and watch the market’s runners from the first push to the fade.</p>
            <LaunchButton size="lg" className="mt-8" />
          </div>
        </section>
      </main>

      <footer className="border-t border-line/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 text-[12px] text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo />
          <p className="max-w-xl leading-relaxed sm:text-right">
            DeltaScan is a research tool, not investment advice. Trading, and short selling in particular, carries a risk of loss
            that can exceed your investment.
          </p>
        </div>
      </footer>
    </div>
  );
}
