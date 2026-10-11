export function normalizeRetryActorId(value: string | null | undefined): string | null {
  const actorId = value?.trim();
  // eslint-disable-next-line no-control-regex -- Control characters are unsafe in browser storage scope keys.
  if (!actorId || actorId.length > 255 || /[\u0000-\u001f\u007f]/u.test(actorId)) return null;
  return actorId;
}
