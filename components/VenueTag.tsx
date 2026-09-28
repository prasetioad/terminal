import { MARKETS, VENUES, splitSource, type SourceId } from "@/lib/venues";

interface VenueTagProps {
  source: SourceId;
  /** Show the venue name next to the logo. */
  withName?: boolean;
}

const MARKET_STYLE = {
  spot: "bg-sky-400/10 text-sky-300",
  perp: "bg-amber-400/10 text-amber-300",
} as const;

/** Exchange logo + S (spot) / P (perpetual) badge. */
export default function VenueTag({ source, withName = false }: VenueTagProps) {
  const { venue, market } = splitSource(source);
  const { name, logo } = VENUES[venue];
  const { short, label } = MARKETS[market];

  return (
    <span className="inline-flex items-center gap-1.5" title={`${name} ${label}`}>
      {/* Tiny static SVGs: a plain img avoids next/image's SVG restrictions for no loss. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} alt={name} width={16} height={16} className="h-4 w-4 shrink-0 rounded-[3px]" />
      {withName && <span className="text-slate-300">{name}</span>}
      <span className={`rounded px-1 font-mono text-[9px] font-bold leading-4 ${MARKET_STYLE[market]}`} aria-label={label}>
        {short}
      </span>
    </span>
  );
}
