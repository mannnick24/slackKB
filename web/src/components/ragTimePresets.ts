export type TimePresetId = "now" | "day" | "week" | "month" | "year" | "all";

export const TIME_PRESETS: { id: TimePresetId; label: string }[] = [
  { id: "now", label: "Now" },
  { id: "day", label: "Last day" },
  { id: "week", label: "Last week" },
  { id: "month", label: "Last month" },
  { id: "year", label: "Last year" },
  { id: "all", label: "All" },
];

/** `datetime-local` value in the user's local timezone. */
export function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function datetimeLocalFromPreset(preset: TimePresetId): string {
  if (preset === "all") return "";
  const now = new Date();
  if (preset === "now") return toDatetimeLocalValue(now);

  const d = new Date(now);
  switch (preset) {
    case "day":
      d.setDate(d.getDate() - 1);
      break;
    case "week":
      d.setDate(d.getDate() - 7);
      break;
    case "month":
      d.setMonth(d.getMonth() - 1);
      break;
    case "year":
      d.setFullYear(d.getFullYear() - 1);
      break;
    default:
      break;
  }
  return toDatetimeLocalValue(d);
}
