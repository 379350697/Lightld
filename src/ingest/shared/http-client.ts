export type FetchImpl = typeof fetch;

type FetchJsonOptions = {
  fetchImpl?: FetchImpl;
};

export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(url);

  if (!response.ok) {
    const detail = [response.status, response.statusText]
      .filter((value) => value !== undefined && value !== '')
      .join(' ')
      .trim();

    throw new Error(detail ? `Request failed for ${url}: ${detail}` : `Request failed for ${url}`);
  }

  return response.json() as Promise<T>;
}
