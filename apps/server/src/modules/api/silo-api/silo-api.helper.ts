import { stripTrailingSlashes } from '@maintainerr/contracts';
import axios, { type AxiosInstance, isAxiosError } from 'axios';
import { applyHttpRetry } from '../lib/httpRetry';
import { MEDIA_SERVER_REQUEST_TIMEOUT_MS } from '../lib/httpTimeouts';
import { SiloRequestPacer } from './silo-request-pacer';

interface SiloApiOptions {
  url: string;
  apiKey: string;
  timeout?: number;
}

/**
 * Thin wrapper around `axios.create` for Silo's native `/api/v2` API, kept in
 * `modules/api/<server>/` like the Emby helper so HTTP-client construction
 * stays out of the media-server adapter.
 *
 * Silo takes an API key as a bearer token on the same header as a session
 * token and decides which it holds. An unscoped key issued to an
 * administrator reaches every route the adapter uses, including the
 * `/api/v2/admin/*` reads of playback history, accounts and collections.
 */
export class SiloApi {
  readonly axios: AxiosInstance;

  constructor(options: SiloApiOptions) {
    this.axios = axios.create({
      baseURL: `${stripTrailingSlashes(options.url)}/api/v2`,
      timeout: options.timeout ?? MEDIA_SERVER_REQUEST_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
    });

    // Registered before the retry policy, so a retried request is paced
    // like any other.
    const pacer = new SiloRequestPacer();
    this.axios.interceptors.request.use(async (config) => {
      await pacer.acquire();
      return config;
    });
    this.axios.interceptors.response.use(
      (response) => {
        pacer.observeLimit(response.headers?.['x-ratelimit-limit']);
        return response;
      },
      (error: unknown) => {
        if (isAxiosError(error)) {
          pacer.observeLimit(error.response?.headers?.['x-ratelimit-limit']);
        }
        return Promise.reject(error);
      },
    );

    applyHttpRetry(this.axios);
  }
}
