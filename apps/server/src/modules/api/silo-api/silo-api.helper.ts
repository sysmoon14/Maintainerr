import { stripTrailingSlashes } from '@maintainerr/contracts';
import axios, { type AxiosInstance } from 'axios';
import { applyHttpRetry } from '../lib/httpRetry';
import { MEDIA_SERVER_REQUEST_TIMEOUT_MS } from '../lib/httpTimeouts';

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

    applyHttpRetry(this.axios);
  }
}
