// Full snapshots on each connection; offsets are JavaScript string lengths (UTF-16),
// not UTF-8 byte counts. This keeps Unicode appends exact in the browser.
export function activityDelta<T extends { id: string; logText: string }>(
  previous: T[],
  current: T[],
) {
  const old = new Map(previous.map((row) => [row.id, row]));
  return current.map((row) => {
    const prior = old.get(row.id);
    if (!prior || !row.logText.startsWith(prior.logText)) return row;
    const { logText, ...metadata } = row;
    return {
      ...metadata,
      logOffset: prior.logText.length,
      logAppend: logText.slice(prior.logText.length),
    };
  });
}
