import { useCallback } from "react";
import { buildApiUrl } from "../config/constants";

const RETRYABLE_STATUSES = new Set([401, 408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableApiError(error) {
  return (
    RETRYABLE_STATUSES.has(Number(error?.status)) ||
    error?.code === "REQUEST_TIMEOUT" ||
    error?.name === "TypeError"
  );
}

export function useApiClient() {
  const performRequest = useCallback(async(path, {
    method = "GET",
    body,
    token,
    timeoutMs = 0,
    timeoutMessage = "",
  }) => {
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timeoutId = timeoutMs > 0 ? window.setTimeout(() => controller?.abort(), timeoutMs) : null;

    try {
      const res = await fetch(buildApiUrl(path), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller?.signal,
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem('2-gather_token');
          localStorage.removeItem('2-gather_user');
          window.location.reload();
        }
        const error = new Error(data.error || data.message || `Request failed (${res.status})`);
        error.status = res.status;
        error.isTimeout = res.status === 408;
        throw error;
      }

      return data;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(timeoutMessage || "Request timed out while waking up the server");
        timeoutError.status = 408;
        timeoutError.code = "REQUEST_TIMEOUT";
        timeoutError.isTimeout = true;
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    }
  }, []);

  const apiClient = useCallback(async(path, {
    method = "GET",
    body,
    token: tokenOverride,
    retryDelaysMs = [],
    timeoutMs = 0,
    timeoutMessage = "",
  } = {}) => {
    let token = tokenOverride || localStorage.getItem("2-gather_token");
    if (!token) throw new Error("Please sign in first");
    
    let retryIndex = 0;
    for (;;) {
      try {
        return await performRequest(path, { method, body, token, timeoutMs, timeoutMessage });
      } catch (error) {
        if (retryIndex >= retryDelaysMs.length || !isRetryableApiError(error)) {
          throw error;
        }
        await sleep(retryDelaysMs[retryIndex]);
        retryIndex += 1;
      }
    }
  }, [performRequest]);

  return { apiClient };
}
