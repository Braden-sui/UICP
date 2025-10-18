import { useEffect, useMemo, useState } from 'react';
import { formatClockDisplay, formatTimeZoneLabel, resolveLocalTimeZone } from '../lib/time/clock';

const TICK_INTERVAL_MS = 1000;

const DesktopClock = () => {
  const [now, setNow] = useState(() => new Date());
  const timeZone = useMemo(() => resolveLocalTimeZone(), []);
  const display = useMemo(() => formatClockDisplay(now), [now]);
  const timeZoneLabel = useMemo(() => formatTimeZoneLabel(timeZone), [timeZone]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(new Date());
    }, TICK_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <div className="pointer-events-none absolute right-10 top-10 z-10 sm:right-14 sm:top-14 md:right-16 md:top-16">
      <div className="rounded-full bg-transparent p-6 text-right text-slate-800">
        <div className="text-4xl font-semibold tracking-tight drop-shadow-sm">
          {display.time}
        </div>
        <div className="mt-1 text-sm uppercase tracking-[0.3em] text-slate-600">
          {display.date}
        </div>
        <div className="mt-2 text-xs font-medium text-slate-500">
          {timeZoneLabel}
        </div>
      </div>
    </div>
  );
};

export default DesktopClock;
