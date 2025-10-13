const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (value: number): string => value.toString().padStart(2, '0');

export const resolveLocalTimeZone = (): string | null => {
  try {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    if (resolved.timeZone && resolved.timeZone.length > 0) {
      return resolved.timeZone;
    }
  } catch (error) {
    if (error instanceof Error) {
      console.warn('Failed to resolve local timezone', error);
    }
  }
  return null;
};

export const formatTimeZoneLabel = (timeZone: string | null): string => {
  if (!timeZone) {
    return 'Local System Time';
  }
  return timeZone.replace(/_/g, ' ').replace(/\//g, ' · ');
};

export type ClockDisplay = {
  time: string;
  date: string;
};

export const formatClockDisplay = (date: Date): ClockDisplay => {
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const time = `${hours}:${minutes}`;
  const weekday = WEEKDAYS[date.getDay()];
  const month = MONTHS[date.getMonth()];
  const day = pad(date.getDate());
  const formattedDate = `${weekday}, ${month} ${day}`;
  return {
    time,
    date: formattedDate,
  };
};
