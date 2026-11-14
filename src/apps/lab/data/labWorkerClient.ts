export type LabWorkerFetch = typeof fetch;

export type LabWorkerResponseDecoder<T> = (value: unknown) => T;

export type LabWorkerClient = {
  get: <T>(path: string, decode: LabWorkerResponseDecoder<T>) => Promise<T>;
  getOptional: <T>(path: string, decode: LabWorkerResponseDecoder<T>) => Promise<T | null>;
  post: <T>(path: string, body: unknown, decode: LabWorkerResponseDecoder<T>) => Promise<T>;
  patch: <T>(path: string, body: unknown, decode: LabWorkerResponseDecoder<T>) => Promise<T>;
};

export function createLabWorkerClient(
  baseUrl: string,
  fetchImpl: LabWorkerFetch = fetch,
): LabWorkerClient {
  return {
    get(path, decode) {
      return requestJson(
        fetchImpl,
        baseUrl,
        path,
        {
          method: "GET",
        },
        decode,
      );
    },

    getOptional(path, decode) {
      return requestJson(
        fetchImpl,
        baseUrl,
        path,
        {
          method: "GET",
          notFoundAsNull: true,
        },
        decode,
      );
    },

    post(path, body, decode) {
      return requestJson(
        fetchImpl,
        baseUrl,
        path,
        {
          method: "POST",
          body,
        },
        decode,
      );
    },

    patch(path, body, decode) {
      return requestJson(
        fetchImpl,
        baseUrl,
        path,
        {
          method: "PATCH",
          body,
        },
        decode,
      );
    },
  };
}

type RequestJsonOptions = {
  method: "GET" | "POST" | "PATCH";
  body?: unknown;
  notFoundAsNull?: boolean;
};

function requestJson<T>(
  fetchImpl: LabWorkerFetch,
  baseUrl: string,
  path: string,
  options: RequestJsonOptions & { notFoundAsNull: true },
  decode: LabWorkerResponseDecoder<T>,
): Promise<T | null>;
function requestJson<T>(
  fetchImpl: LabWorkerFetch,
  baseUrl: string,
  path: string,
  options: RequestJsonOptions & { notFoundAsNull?: false },
  decode: LabWorkerResponseDecoder<T>,
): Promise<T>;
async function requestJson<T>(
  fetchImpl: LabWorkerFetch,
  baseUrl: string,
  path: string,
  options: RequestJsonOptions,
  decode: LabWorkerResponseDecoder<T>,
): Promise<T | null> {
  const init: RequestInit = {
    method: options.method,
  };

  if (options.body !== undefined) {
    init.headers = {
      "Content-Type": "application/json",
    };
    init.body = JSON.stringify(options.body);
  }

  const response = await fetchImpl(buildLabWorkerUrl(baseUrl, path), init);

  if (options.notFoundAsNull === true && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  try {
    const payload: unknown = await response.json();
    return decode(payload);
  } catch (error) {
    throw new Error(
      `Interview Lab Worker returned an invalid response for ${options.method} ${path}.`,
      {
        cause: error,
      },
    );
  }
}

function buildLabWorkerUrl(baseUrl: string, path: string): string {
  const trimmedBaseUrl = baseUrl.trim();

  if (trimmedBaseUrl.length === 0) {
    throw new Error("Set VITE_LAB_WORKER_URL before using the Interview Lab Worker.");
  }

  return new URL(path, trimmedBaseUrl).toString();
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `Interview Lab Worker request failed with status ${response.status}.`;

  try {
    const payload: unknown = await response.json();

    if (
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      "error" in payload &&
      typeof payload.error === "string"
    ) {
      return payload.error;
    }
  } catch {
    return fallback;
  }

  return fallback;
}
