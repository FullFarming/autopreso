export function getLoginRetryDeadline(value: string | null, now: number): number | null {
  if (!value || !Number.isFinite(now)) return null;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const deadline = now + Number(trimmed) * 1000;
    return Number.isSafeInteger(deadline) ? deadline : null;
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(trimmed)) return null;
  const deadline = Date.parse(trimmed);
  return Number.isFinite(deadline) ? Math.max(now, deadline) : null;
}

export function getLoginRetrySeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
