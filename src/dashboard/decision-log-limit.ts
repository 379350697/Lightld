export function limitDecisionLogEntries<T>(entries: T[], maxEntries = 10) {
  return entries.slice(-maxEntries).reverse();
}
