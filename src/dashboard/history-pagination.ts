export type HistoryPaginationResult<T> = {
  entries: T[];
  page: number;
  pageSize: number;
  totalEntries: number;
  totalPages: number;
  hasPrevPage: boolean;
  hasNextPage: boolean;
};

export function paginateHistoryEntries<T>(entries: T[], input?: {
  page?: number;
  pageSize?: number;
}): HistoryPaginationResult<T> {
  const pageSize = Math.max(1, Math.floor(input?.pageSize ?? 10));
  const totalEntries = entries.length;
  const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));
  const requestedPage = Math.floor(input?.page ?? 1);
  const page = Math.min(totalPages, Math.max(1, requestedPage));
  const start = (page - 1) * pageSize;

  return {
    entries: entries.slice(start, start + pageSize),
    page,
    pageSize,
    totalEntries,
    totalPages,
    hasPrevPage: page > 1,
    hasNextPage: page < totalPages
  };
}
