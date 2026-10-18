/** "há 4 s", "há 12 min", "há 3 h", "há 2 d": how long ago, in the unit a person would say. */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `há ${seconds} s`;
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `há ${Math.floor(seconds / 3600)} h`;
  return `há ${Math.floor(seconds / 86_400)} d`;
}

export const fullDateTime = (iso: string) => new Date(iso).toLocaleString("pt-BR");
