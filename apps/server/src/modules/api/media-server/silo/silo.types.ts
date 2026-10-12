/**
 * The subset of Silo's native `/api/v2` contract the adapter reads. Field names
 * follow the published OpenAPI document (`contracts/api/v2/openapi.json` in
 * the Silo repository); everything not listed here is ignored.
 */

/** Cursor state on every paginated Silo collection. */
interface SiloPage {
  has_more: boolean;
  next_cursor?: string;
}

export interface SiloCollection<T> {
  items: T[];
  page?: SiloPage;
}

/** GET /system/info */
export interface SiloSystemInfo {
  api_major: number;
  server_version: string;
}

/** GET /system/identity */
export interface SiloServerIdentity {
  server_id: string;
}

/** GET /account/me */
export interface SiloAccount {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

/** GET /admin/users */
export interface SiloAdminUser {
  id: string;
  username: string;
  enabled: boolean;
  role: 'admin' | 'user';
}

/** GET /admin/users/{id}/profiles */
export interface SiloProfile {
  id: string;
  name: string;
}

/** GET /profiles - the profiles of the authenticated account */
export interface SiloOwnProfile {
  id: string;
  name: string;
  is_primary: boolean;
  library_restrictions_enabled: boolean;
  max_content_rating: string;
  max_advisory_age: number | null;
}

/** GET /libraries */
export interface SiloLibrary {
  id: string;
  name: string;
  /** movies, series, mixed, audiobooks, ebooks, podcasts or manga */
  type: string;
  enabled: boolean;
}

export type SiloItemType =
  | 'movie'
  | 'series'
  | 'season'
  | 'episode'
  | 'audiobook'
  | 'ebook'
  | 'podcast'
  | 'podcast_episode';

/** One file of an item, as GET /catalog/items/{id} lists it. */
export interface SiloVersion {
  file_id: string;
  added_at?: string;
  /** Seconds */
  duration?: number;
  /** Kilobits per second */
  bitrate?: number;
  codec_audio?: string;
  codec_video?: string;
  container?: string;
  resolution?: string;
  /** Bytes */
  file_size?: number;
  file_path?: string;
}

export interface SiloCastMember {
  name: string;
  character?: string;
  photo_url?: string;
}

/**
 * A catalog card (GET /catalog) or detail page (GET /catalog/items/{id}).
 * Cards carry a subset of the detail fields, which is why most are optional.
 */
export interface SiloCatalogItem {
  content_id: string;
  type: SiloItemType;
  title: string;
  added_at?: string;
  overview?: string;
  year?: number;
  release_date?: string;
  first_air_date?: string;
  air_date?: string;
  content_rating?: string;
  genres?: string[];
  studios?: string[];
  /** Minutes */
  runtime?: number;
  duration_seconds?: number;
  series_id?: string;
  series_title?: string;
  season_number?: number;
  episode_number?: number;
  season_count?: number;
  episode_count?: number;
  rating_imdb?: number;
  rating_tmdb?: number;
  rating_rt_critic?: number;
  rating_rt_audience?: number;
  imdb_id?: string;
  tmdb_id?: string;
  tvdb_id?: string;
  folder_paths?: string[];
  versions?: SiloVersion[];
  cast?: SiloCastMember[];
}

/**
 * GET /progress - one profile's watch state per item. A completed entry is
 * the item counting as watched, whether it was played to the end, marked
 * watched by hand or brought in by a history import.
 */
export interface SiloProgressEntry {
  media_item_id: string;
  completed: boolean;
  updated_at: string;
}

/** GET /catalog */
export interface SiloCatalogPage extends SiloCollection<SiloCatalogItem> {
  /** Items in the whole result; an estimate unless total_exact */
  total: number;
  total_exact: boolean;
}

/** GET /catalog/series/{id}/seasons */
export interface SiloSeason {
  content_id: string;
  season_number: number;
  title: string;
  episode_count: number;
  air_date?: string;
  overview?: string;
}

/** GET /admin/playback-history */
export interface SiloPlaybackHistoryEntry {
  session_id: string;
  user_id: string;
  profile_id: string;
  profile_name: string;
  /** Catalog content id; empty when the attempt was not attributed to an item */
  media_item_id: string;
  /** episode, or the catalog item type; empty when unknown */
  media_type: string;
  started_at: string;
  ended_at: string;
  completed: boolean;
}

/** GET /admin/sessions */
export interface SiloPlaybackSession {
  session_id: string;
  content_id?: string;
  media_type: string;
}

/** GET /admin/collections and the single-collection reads */
export interface SiloAdminCollection {
  id: string;
  title: string;
  description: string;
  library_id: string;
  library_ids: string[];
  item_count: number;
  /** manual, or the kind of a query-driven (smart) collection */
  collection_type: string;
  management_mode: string;
  created_at: string;
  updated_at: string;
  poster_url?: string;
}

/** GET /admin/collections/{id}/items */
export interface SiloAdminCollectionItem {
  collection_id: string;
  /** The member's catalog content id */
  media_item_id: string;
  position: number;
  /** Catalog title when the item is available */
  title?: string;
}

/** An RFC 9457 problem document, the shape of every Silo error response */
export interface SiloProblem {
  title?: string;
  detail?: string;
  errors?: Array<{ location?: string; detail?: string }>;
}
