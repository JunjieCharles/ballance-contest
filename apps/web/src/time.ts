const utc8OffsetMs = 8 * 60 * 60_000;

export const toUtc8Input = (date: Date): string =>
  new Date(date.getTime() + utc8OffsetMs).toISOString().slice(0, 16);

export const utc8InputToIso = (value: string): string =>
  new Date(`${value}:00+08:00`).toISOString();

export const formatUtc8DateTime = (value?: string): string => value
  ? new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(value))
  : "未设置";
