import {
  MediaServerFeature,
  MediaServerType,
  type CollectionVisibilitySettings,
  type CreateCollectionParams,
  type LibraryQueryOptions,
  type MediaCollection,
  type MediaItem,
  type MediaItemType,
  type MediaLibrary,
  type MediaLibrarySortField,
  type MediaPlaylist,
  type MediaServerStatus,
  type MediaUser,
  type PagedResult,
  type RecentlyAddedOptions,
  type UpdateCollectionParams,
  type WatchRecord,
} from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import { type AxiosInstance, isAxiosError } from 'axios';
import { chunk } from 'lodash';
import {
  formatConnectionFailureMessage,
  logConnectionTestError,
} from '../../../../utils/connection-error';
import { MaintainerrLogger } from '../../../logging/logs.service';
import { SettingsDataService } from '../../../settings/settings-data.service';
import cacheManager, { type Cache } from '../../lib/cache';
import { assertApiKey, connectionTestConfig } from '../../lib/connectionTest';
import { SiloApi } from '../../silo-api/silo-api.helper';
import { resolveContextActionIds } from '../context-action.util';
import { supportsFeature } from '../media-server.constants';
import type {
  CollectionMutationOutcome,
  IMediaServerService,
  MediaWatchState,
} from '../media-server.interface';
import {
  classifyMutationError,
  recordMutationFailure,
} from '../mutation-outcome.util';
import {
  SILO_BATCH_SIZE,
  SILO_CACHE_KEYS,
  SILO_CACHE_TTL,
  SILO_SERVER_NAME,
  SILO_WATCH_SNAPSHOT_KEY,
} from './silo.constants';
import { SiloMapper } from './silo.mapper';
import type {
  SiloAccount,
  SiloAdminCollection,
  SiloAdminCollectionItem,
  SiloAdminUser,
  SiloCatalogItem,
  SiloCatalogPage,
  SiloCollection,
  SiloLibrary,
  SiloOwnProfile,
  SiloPlaybackHistoryEntry,
  SiloPlaybackSession,
  SiloProblem,
  SiloProfile,
  SiloSeason,
  SiloServerIdentity,
  SiloSystemInfo,
} from './silo.types';

/**
 * The whole server's playback history, indexed by catalog item. Silo answers
 * it from one endpoint, so unlike the Jellyfin sweep an item with no entry is
 * a confirmed "never played" as of the snapshot, not an item the sweep missed.
 */
interface ListedItem {
  addedAt?: string;
  library?: { id: string; title: string };
}

/** When the item's oldest file was added, for a read that names no date. */
const oldestFile = (item: SiloCatalogItem): string | undefined =>
  (item.versions ?? [])
    .map((version) => version.added_at)
    .filter((addedAt): addedAt is string => Boolean(addedAt))
    .sort()[0];

interface SiloWatchSnapshot {
  /** Completed plays, newest first */
  completed: Map<string, WatchRecord[]>;
  /** Newest play of any length, as epoch ms */
  lastPlayedAt: Map<string, number>;
  /** Plays of any length */
  plays: Map<string, number>;
}

/**
 * Silo media server adapter.
 *
 * Implements IMediaServerService against Silo's native `/api/v2` API rather
 * than its optional Jellyfin-compatible API, which serves client playback
 * and lacks the administrator reads Maintainerr needs (library folders,
 * every profile's watch state, collection writes).
 *
 * Model notes:
 * - Users are household profiles. Silo records watch state per profile, and
 *   one login account can hold several, so a rule naming a viewer names a
 *   profile.
 * - Watch history is `GET /admin/playback-history`: every account's and
 *   profile's finalized plays, each with a completion flag. Only real plays
 *   are recorded there; an item marked watched by hand or brought in by a
 *   history import does not appear.
 * - A show or season has no plays of its own. Its history is its episodes'
 *   history, the same reading Plex gives a show.
 * - Collections are Silo's administrator library collections. Manual
 *   membership only holds movies and shows, so season and episode rule
 *   groups must keep their collection in Maintainerr only.
 * - Silo never writes to the media folders, so there is no delete. Files go
 *   through Radarr or Sonarr, and scanFolder tells Silo they are gone.
 */
@Injectable()
export class SiloAdapterService implements IMediaServerService {
  private http: AxiosInstance | undefined;
  private initialized = false;
  private siloUrl: string | undefined;
  private readonly cache: Cache;
  private readonly snapshotCache: Cache;
  // Shared in-flight metadata reads, keyed by item id. See getMetadata.
  private readonly metadataRequests = new Map<
    string,
    Promise<MediaItem | undefined>
  >();
  private watchSnapshotPrefetch: Promise<void> | undefined;

  constructor(
    private readonly settings: SettingsDataService,
    private readonly logger: MaintainerrLogger,
  ) {
    this.logger.setContext(SiloAdapterService.name);
    this.cache = cacheManager.getCache('silo');
    this.snapshotCache = cacheManager.getCache('silowatchhistory');
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    const url = this.settings.silo_url;
    const apiKey = this.settings.silo_api_key;

    if (!url || !apiKey) {
      this.logger.debug(
        'Silo settings incomplete - skipping initialize (url or api_key missing)',
      );
      this.initialized = false;
      this.http = undefined;
      return;
    }

    const http = new SiloApi({ url, apiKey }).axios;

    try {
      const [info] = await Promise.all([
        http.get<SiloSystemInfo>('/system/info'),
        this.authenticate(http),
      ]);
      this.http = http;
      this.siloUrl = url;
      this.initialized = true;
      this.logger.log(
        `Silo connection established (${info.data.server_version || 'unknown version'})`,
      );
    } catch (error) {
      this.initialized = false;
      this.http = undefined;
      this.logger.warn(
        `Failed to initialize Silo connection: ${this.describeFailure(error)}`,
      );
    }
  }

  uninitialize(): void {
    this.http = undefined;
    this.initialized = false;
    this.siloUrl = undefined;
    this.cache.flush();
    this.snapshotCache.flush();
  }

  isSetup(): boolean {
    return this.initialized && this.http !== undefined;
  }

  getServerType(): MediaServerType {
    return MediaServerType.SILO;
  }

  supportsFeature(feature: MediaServerFeature): boolean {
    return supportsFeature(MediaServerType.SILO, feature);
  }

  async testConnection(
    url: string,
    apiKey: string,
    timeoutMs?: number,
  ): Promise<{
    success: boolean;
    serverName?: string;
    version?: string;
    error?: string;
  }> {
    try {
      assertApiKey(apiKey);
      const probe = new SiloApi({ url, apiKey }).axios;
      const config = connectionTestConfig(timeoutMs);
      const [info] = await Promise.all([
        probe.get<SiloSystemInfo>('/system/info', config),
        this.authenticate(probe, config),
      ]);
      return {
        success: true,
        serverName: SILO_SERVER_NAME,
        version: info.data.server_version,
      };
    } catch (error) {
      logConnectionTestError(this.logger, 'Silo', error);
      return {
        success: false,
        error: this.describeFailure(error),
      };
    }
  }

  /**
   * Check the key and choose the profile every request acts as.
   *
   * Every read Maintainerr depends on is an administrator route, and a key
   * owned by an ordinary account answers 403 on each of them one at a time,
   * so it is refused up front.
   *
   * Silo's catalog reads require an acting profile (X-Profile-Id), and
   * administrator routes only accept the account's primary profile, so every
   * request names that one. An API key is never asked for a profile PIN.
   */
  private async authenticate(
    http: AxiosInstance,
    config?: ReturnType<typeof connectionTestConfig>,
  ): Promise<void> {
    const { data: account } = await http.get<SiloAccount>(
      '/account/me',
      config,
    );
    if (account.role !== 'admin') {
      throw new Error(
        'The Silo API key must belong to an administrator account',
      );
    }

    const { data: profiles } = await http.get<SiloCollection<SiloOwnProfile>>(
      '/profiles',
      config,
    );
    this.assertItems(profiles, 'the account profiles');
    const primary = profiles.items.find((profile) => profile.is_primary);
    if (!primary) {
      throw new Error('The Silo account has no primary profile');
    }
    if (
      primary.library_restrictions_enabled ||
      primary.max_content_rating ||
      primary.max_advisory_age !== null
    ) {
      this.logger.warn(
        `Silo profile '${primary.name}' has viewing restrictions; Maintainerr only sees what that profile can see`,
      );
    }
    http.defaults.headers.common['X-Profile-Id'] = primary.id;
  }

  // ============================================================================
  // Server / Users
  // ============================================================================

  async getStatus(): Promise<MediaServerStatus | undefined> {
    if (!this.http) return undefined;
    try {
      const cached = this.cache.data.get<MediaServerStatus>(
        SILO_CACHE_KEYS.STATUS,
      );
      if (cached) return cached;

      const [info, identity] = await Promise.all([
        this.http.get<SiloSystemInfo>('/system/info'),
        this.http.get<SiloServerIdentity>('/system/identity'),
      ]);
      const status: MediaServerStatus = {
        machineId: identity.data.server_id,
        version: info.data.server_version,
        name: SILO_SERVER_NAME,
        url: this.siloUrl,
      };
      this.cache.data.set(
        SILO_CACHE_KEYS.STATUS,
        status,
        SILO_CACHE_TTL.STATUS,
      );
      return status;
    } catch (error) {
      this.logger.debug(
        `Silo getStatus failed: ${this.describeFailure(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Every household profile of every enabled account. A profile name is only
   * unique within its account, so a name two accounts share is qualified with
   * the account's username - rules store viewers by name.
   */
  async getUsers(throwOnError = false): Promise<MediaUser[]> {
    if (!this.http) {
      if (throwOnError) {
        throw new Error('Silo API not initialized');
      }
      return [];
    }

    const cached = this.cache.data.get<MediaUser[]>(SILO_CACHE_KEYS.USERS);
    if (cached) return cached;

    try {
      const accounts = (
        await this.readAllPages<SiloAdminUser>('/admin/users')
      ).filter((account) => account.enabled);

      const profilesByAccount: Array<{
        account: SiloAdminUser;
        profiles: SiloProfile[];
      }> = [];
      for (const batch of chunk(accounts, SILO_BATCH_SIZE.METADATA)) {
        const results = await Promise.all(
          batch.map(async (account) => ({
            account,
            profiles: await this.readList<SiloProfile>(
              `/admin/users/${encodeURIComponent(account.id)}/profiles`,
            ),
          })),
        );
        profilesByAccount.push(...results);
      }

      const nameCounts = new Map<string, number>();
      for (const { profiles } of profilesByAccount) {
        for (const profile of profiles) {
          nameCounts.set(profile.name, (nameCounts.get(profile.name) ?? 0) + 1);
        }
      }

      const users: MediaUser[] = profilesByAccount.flatMap(
        ({ account, profiles }) =>
          profiles.map((profile) => ({
            id: profile.id,
            name:
              (nameCounts.get(profile.name) ?? 0) > 1
                ? `${profile.name} (${account.username})`
                : profile.name,
          })),
      );

      this.cache.data.set(SILO_CACHE_KEYS.USERS, users, SILO_CACHE_TTL.USERS);
      return users;
    } catch (error) {
      this.logger.debug(`Silo getUsers failed: ${this.describeFailure(error)}`);
      if (throwOnError) {
        throw error;
      }
      return [];
    }
  }

  async getUser(id: string): Promise<MediaUser | undefined> {
    return (await this.getUsers()).find((user) => user.id === id);
  }

  // ============================================================================
  // Libraries
  // ============================================================================

  async getLibraries(): Promise<MediaLibrary[]> {
    if (!this.http) return [];
    try {
      const cached = this.cache.data.get<MediaLibrary[]>(
        SILO_CACHE_KEYS.LIBRARIES,
      );
      if (cached) return cached;

      const all = await this.readList<SiloLibrary>('/libraries');
      const usable = all.filter(
        (library) =>
          library.enabled &&
          SiloMapper.toLibraryType(library.type) !== undefined,
      );
      const skipped = all.filter((library) => !usable.includes(library));
      if (skipped.length > 0) {
        this.logger.debug(
          `Silo libraries Maintainerr cannot manage: ${skipped
            .map(
              (library) =>
                `${library.name} (${library.type}${library.enabled ? '' : ', disabled'})`,
            )
            .join(', ')}`,
        );
      }
      const libraries = usable.map(SiloMapper.toMediaLibrary);

      this.cache.data.set(
        SILO_CACHE_KEYS.LIBRARIES,
        libraries,
        SILO_CACHE_TTL.LIBRARIES,
      );
      return libraries;
    } catch (error) {
      this.logger.warn(
        `Silo getLibraries failed: ${this.describeFailure(error)}`,
      );
      return [];
    }
  }

  // Silo exposes no per-library storage total, and catalog listings carry no
  // file sizes, so sizing a library would cost one detail read per item.
  async getLibrariesStorage(): Promise<Map<string, number>> {
    return new Map();
  }

  async computeLibraryStorageSizes(): Promise<Map<string, number>> {
    return new Map();
  }

  async getLibraryContents(
    libraryId: string,
    options?: LibraryQueryOptions,
  ): Promise<PagedResult<MediaItem>> {
    if (!this.http) {
      throw new Error('Silo not initialized');
    }
    const limit = Math.min(
      options?.limit ?? SILO_BATCH_SIZE.DEFAULT_PAGE_SIZE,
      SILO_BATCH_SIZE.MAX_PAGE_SIZE,
    );
    const offset = options?.offset ?? 0;

    try {
      if (options?.type === 'season') {
        const seasons = await this.getLibrarySeasons(libraryId);
        return {
          items: seasons.slice(offset, offset + limit),
          totalSize: seasons.length,
          offset,
          limit,
        };
      }

      const library = await this.getLibraryRef(libraryId);
      const page = await this.readCatalogPage({
        library_id: libraryId,
        type: await this.catalogTypeFor(libraryId, options?.type),
        sort: this.toSiloSort(options?.sort, options?.sortOrder),
        limit,
        seek: offset > 0 ? offset : undefined,
      });

      return {
        items: await this.toMediaItems(page.items, library),
        totalSize: page.total,
        offset,
        limit,
      };
    } catch (error) {
      this.logger.warn(
        `Silo getLibraryContents(${libraryId}) failed: ${this.describeFailure(error)}`,
      );
      // A fabricated empty page reads as end-of-library downstream, which
      // truncates rule evaluation and mass-removes the unevaluated tail from
      // collections (#3307).
      throw error;
    }
  }

  async getLibraryContentCount(
    libraryId: string,
    type?: MediaItemType,
  ): Promise<number> {
    if (!this.http) {
      throw new Error('Silo not initialized');
    }
    try {
      if (type === 'season') {
        return (await this.getLibrarySeasons(libraryId)).length;
      }

      const page = await this.readCatalogPage({
        library_id: libraryId,
        type: await this.catalogTypeFor(libraryId, type),
        limit: 1,
      });
      return page.total;
    } catch (error) {
      this.logger.debug(
        `Silo getLibraryContentCount(${libraryId}) failed: ${this.describeFailure(error)}`,
      );
      // Same contract as getLibraryContents: a fabricated count masks a
      // failed read from callers that gate work on it.
      throw error;
    }
  }

  async searchLibraryContents(
    libraryId: string,
    query: string,
    type?: MediaItemType,
  ): Promise<MediaItem[]> {
    if (!this.http) return [];
    try {
      const library = await this.getLibraryRef(libraryId);
      const page = await this.readCatalogPage({
        library_id: libraryId,
        type: await this.catalogTypeFor(libraryId, type),
        q: query,
        limit: SILO_BATCH_SIZE.DEFAULT_PAGE_SIZE,
      });
      return await this.toMediaItems(page.items, library);
    } catch (error) {
      this.logger.debug(
        `Silo searchLibraryContents failed: ${this.describeFailure(error)}`,
      );
      return [];
    }
  }

  async getRecentlyAdded(
    libraryId: string,
    options?: RecentlyAddedOptions,
  ): Promise<MediaItem[]> {
    if (!this.http) return [];
    try {
      const library = await this.getLibraryRef(libraryId);
      const page = await this.readCatalogPage({
        library_id: libraryId,
        type: await this.catalogTypeFor(libraryId, options?.type),
        sort: '-added_at',
        limit: Math.min(options?.limit ?? 20, SILO_BATCH_SIZE.MAX_PAGE_SIZE),
      });
      return await this.toMediaItems(page.items, library);
    } catch (error) {
      this.logger.debug(
        `Silo getRecentlyAdded(${libraryId}) failed: ${this.describeFailure(error)}`,
      );
      return [];
    }
  }

  async searchContent(query: string): Promise<MediaItem[]> {
    if (!this.http) return [];
    try {
      const page = await this.readCatalogPage({
        type: 'video',
        q: query,
        limit: SILO_BATCH_SIZE.DEFAULT_PAGE_SIZE,
      });
      return await this.toMediaItems(page.items);
    } catch (error) {
      this.logger.debug(
        `Silo searchContent failed: ${this.describeFailure(error)}`,
      );
      return [];
    }
  }

  // ============================================================================
  // Metadata
  // ============================================================================

  /**
   * Cached for the same reason as the Jellyfin and Emby adapters': every rule
   * condition re-reads the evaluated item and its parents through here (#3355),
   * and concurrently evaluated siblings share the in-flight read. Only a
   * resolved item is stored, so a failed read is retried next time.
   */
  async getMetadata(itemId: string): Promise<MediaItem | undefined> {
    if (!this.http) return undefined;

    const cacheKey = `${SILO_CACHE_KEYS.METADATA}:${itemId}`;
    const cached = this.cache.data.get<MediaItem>(cacheKey);
    if (cached !== undefined) return cached;

    const inFlight = this.metadataRequests.get(itemId);
    if (inFlight !== undefined) return inFlight;

    const pending = this.fetchMetadata(itemId, cacheKey).finally(() => {
      this.metadataRequests.delete(itemId);
    });
    this.metadataRequests.set(itemId, pending);

    return pending;
  }

  /**
   * Silo has no multi-id item read, so this is a bounded fan-out of the
   * single-item read - which also means it shares getMetadata's cache.
   */
  async getMetadataBatch(itemIds: string[]): Promise<MediaItem[]> {
    if (!this.http) return [];

    const items: MediaItem[] = [];
    for (const batch of chunk(
      [...new Set(itemIds)],
      SILO_BATCH_SIZE.METADATA,
    )) {
      const results = await Promise.all(
        batch.map((itemId) => this.getMetadata(itemId)),
      );
      for (const item of results) {
        if (item) items.push(item);
      }
    }
    return items;
  }

  async itemExists(itemId: string): Promise<boolean> {
    if (!this.http) {
      throw new Error('Silo not initialized');
    }

    try {
      return Boolean(await this.fetchItem(itemId));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return false;
      }
      // Anything else is inconclusive and must not read as "deleted".
      throw error;
    }
  }

  private async fetchMetadata(
    itemId: string,
    cacheKey: string,
  ): Promise<MediaItem | undefined> {
    try {
      const data = await this.fetchItem(itemId);
      if (!data) return undefined;

      const seasonId =
        data.type === 'episode' && data.series_id
          ? await this.getSeasonId(data.series_id, data.season_number)
          : undefined;
      // A detail read names neither the item's added date nor its library;
      // only listing cards carry those. Take them from the listing that
      // surfaced the item, or the date from its oldest file.
      const listed = this.cache.data.get<ListedItem>(
        `${SILO_CACHE_KEYS.LISTED}:${itemId}`,
      );
      const mediaItem = SiloMapper.toMediaItem(
        {
          ...data,
          added_at: data.added_at ?? listed?.addedAt ?? oldestFile(data),
        },
        { seasonId, library: listed?.library },
      );
      this.cache.data.set(cacheKey, mediaItem, SILO_CACHE_TTL.METADATA);
      return mediaItem;
    } catch (error) {
      this.logger.debug(
        `Silo getMetadata(${itemId}) failed: ${this.describeFailure(error)}`,
      );
      return undefined;
    }
  }

  private async fetchItem(
    itemId: string,
  ): Promise<SiloCatalogItem | undefined> {
    const { data } = await this.http!.get<SiloCatalogItem>(
      `/catalog/items/${encodeURIComponent(itemId)}`,
    );
    return data?.content_id ? data : undefined;
  }

  /**
   * Cached like the other adapters' (#3355). Only a completed read is stored.
   */
  async getChildrenMetadata(
    parentId: string,
    childType?: MediaItemType,
    throwOnError = false,
  ): Promise<MediaItem[]> {
    if (!this.http) {
      if (throwOnError) {
        throw new Error('Silo API not initialized');
      }
      return [];
    }

    const cacheKey = `${SILO_CACHE_KEYS.CHILDREN}:${parentId}:${childType ?? 'any'}`;
    const cached = this.cache.data.get<MediaItem[]>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const parent = await this.fetchItem(parentId);
      if (!parent) {
        throw new Error(`Silo item ${parentId} not found`);
      }

      let children: MediaItem[] = [];
      if (parent.type === 'series') {
        const seasons = await this.readSeasons(parent);
        children =
          childType === 'episode'
            ? await this.readEpisodesOfSeasons(seasons)
            : seasons;
      } else if (parent.type === 'season' && childType !== 'season') {
        children = await this.readEpisodes(parentId);
      }

      this.cache.data.set(cacheKey, children, SILO_CACHE_TTL.METADATA);
      return children;
    } catch (error) {
      if (throwOnError) {
        throw new Error(
          `Could not read the children of Silo item ${parentId}`,
          {
            cause: error,
          },
        );
      }

      this.logger.debug(
        `Silo getChildrenMetadata(${parentId}) failed: ${this.describeFailure(error)}`,
      );
      return [];
    }
  }

  // ============================================================================
  // Watch State
  // ============================================================================

  /**
   * Snapshot the whole server's playback history. Silo answers it from one
   * paginated endpoint, so there is one snapshot for every library rather than
   * a sweep per library.
   *
   * Best-effort by contract: on failure nothing is cached and every caller
   * falls back to a live per-item read.
   */
  async prefetchWatchHistory({
    abortSignal,
  }: {
    libraryId: string;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    if (!this.http) return;
    if (this.snapshotCache.data.has(SILO_WATCH_SNAPSHOT_KEY)) return;

    this.watchSnapshotPrefetch ??= this.buildWatchSnapshot(abortSignal).finally(
      () => {
        this.watchSnapshotPrefetch = undefined;
      },
    );
    return this.watchSnapshotPrefetch;
  }

  private async buildWatchSnapshot(abortSignal?: AbortSignal): Promise<void> {
    try {
      this.logger.log('Prefetching Silo playback history for all profiles...');
      const entries = await this.readAllPages<SiloPlaybackHistoryEntry>(
        '/admin/playback-history',
        {},
        abortSignal,
      );

      const snapshot: SiloWatchSnapshot = {
        completed: new Map(),
        lastPlayedAt: new Map(),
        plays: new Map(),
      };
      for (const entry of entries) {
        if (!entry.media_item_id) continue;
        this.addToSnapshot(snapshot, entry);
      }

      this.snapshotCache.data.set(SILO_WATCH_SNAPSHOT_KEY, snapshot);
      this.logger.log(
        `Prefetched ${entries.length} Silo playback history entries`,
      );
    } catch (error) {
      this.logger.warn(
        'Silo playback history prefetch failed - falling back to per-item reads.',
      );
      this.logger.debug(error);
    }
  }

  private addToSnapshot(
    snapshot: SiloWatchSnapshot,
    entry: SiloPlaybackHistoryEntry,
  ): void {
    const itemId = entry.media_item_id;
    snapshot.plays.set(itemId, (snapshot.plays.get(itemId) ?? 0) + 1);

    const endedMs = new Date(entry.ended_at).getTime();
    if (!Number.isNaN(endedMs)) {
      const newest = snapshot.lastPlayedAt.get(itemId);
      if (newest === undefined || endedMs > newest) {
        snapshot.lastPlayedAt.set(itemId, endedMs);
      }
    }

    if (entry.completed) {
      const records = snapshot.completed.get(itemId) ?? [];
      records.push(SiloMapper.toWatchRecord(entry));
      snapshot.completed.set(itemId, records);
    }
  }

  private getWatchSnapshot(): SiloWatchSnapshot | undefined {
    return this.snapshotCache.data.get<SiloWatchSnapshot>(
      SILO_WATCH_SNAPSHOT_KEY,
    );
  }

  /**
   * Completed plays of one movie or episode, or of every episode under a show
   * or season.
   *
   * Errors propagate so callers can tell a real outage from a confirmed empty
   * history; answering [] on a failure would read as "never watched".
   */
  async getWatchHistory(
    itemId: string,
    useSnapshot = true,
  ): Promise<WatchRecord[]> {
    if (!this.http) return [];

    const leafIds = await this.getPlayableIds(itemId);
    const records: WatchRecord[] = [];
    for (const leafId of leafIds) {
      records.push(...(await this.getLeafWatchHistory(leafId, useSnapshot)));
    }
    return records;
  }

  /**
   * The newest play of any length, finished or not. Separate from
   * getWatchHistory, whose completed-play semantics feed lastViewedAt, seenBy
   * and viewCount.
   */
  async getLastPlayedAt(itemId: string): Promise<Date | null> {
    if (!this.http) {
      throw new Error('Silo not initialized');
    }

    let latestMs: number | undefined;
    for (const leafId of await this.getPlayableIds(itemId)) {
      const playedMs = await this.getLeafLastPlayedAt(leafId);
      if (
        playedMs !== undefined &&
        (latestMs === undefined || playedMs > latestMs)
      ) {
        latestMs = playedMs;
      }
    }
    return latestMs === undefined ? null : new Date(latestMs);
  }

  /** Plays of any length, unfinished ones included. */
  async getTotalPlayCount(itemId: string): Promise<number> {
    if (!this.http) {
      throw new Error('Silo not initialized');
    }

    let total = 0;
    for (const leafId of await this.getPlayableIds(itemId)) {
      total += await this.getLeafPlayCount(leafId);
    }
    return total;
  }

  async getWatchState(
    itemId: string,
    nativeViewCount?: number,
  ): Promise<MediaWatchState> {
    // Deliberately bypasses the prefetched snapshot: this is the is-watched /
    // viewCount read that feeds deletions, so it asks Silo live and something
    // just watched can never be deleted off a stale snapshot. Mirrors the
    // Plex and Jellyfin adapters.
    const history = await this.getWatchHistory(itemId, false);
    const viewCount = history.length;
    return {
      viewCount,
      isWatched:
        viewCount > 0 || (nativeViewCount !== undefined && nativeViewCount > 0),
    };
  }

  async getItemSeenBy(itemId: string): Promise<string[]> {
    const history = await this.getWatchHistory(itemId);
    return [...new Set(history.map((record) => record.userId))];
  }

  /**
   * Completed plays of every episode under `parentId`, keyed by episode id,
   * with an entry (possibly empty) for every episode. All-or-nothing: a
   * failed read throws rather than leaving an episode out, which would read
   * as "never watched".
   */
  async getDescendantEpisodeWatchHistory(
    parentId: string,
    parentType: 'show' | 'season',
  ): Promise<Record<string, WatchRecord[]>> {
    const episodes = await this.getChildrenMetadata(
      parentId,
      parentType === 'show' ? 'episode' : undefined,
      true,
    );

    const watchHistory: Record<string, WatchRecord[]> = {};
    for (const episode of episodes) {
      watchHistory[episode.id] = await this.getLeafWatchHistory(
        episode.id,
        true,
      );
    }
    return watchHistory;
  }

  /** Profiles that finished at least one episode under `parentId`. */
  async getDescendantEpisodeWatchers(parentId: string): Promise<string[]> {
    return this.getItemSeenBy(parentId);
  }

  private async getLeafWatchHistory(
    itemId: string,
    useSnapshot: boolean,
  ): Promise<WatchRecord[]> {
    const snapshot = useSnapshot ? this.getWatchSnapshot() : undefined;
    if (snapshot) {
      // The snapshot cache stores by reference, so hand callers a copy.
      return [...(snapshot.completed.get(itemId) ?? [])];
    }

    const cacheKey = `${SILO_CACHE_KEYS.WATCH_HISTORY}:${itemId}`;
    if (useSnapshot) {
      const cached = this.cache.data.get<WatchRecord[]>(cacheKey);
      if (cached) return [...cached];
    }

    const entries = await this.readAllPages<SiloPlaybackHistoryEntry>(
      '/admin/playback-history',
      { media_item_id: itemId, completed: 'true' },
    );
    const records = entries.map(SiloMapper.toWatchRecord);
    this.cache.data.set(cacheKey, records, SILO_CACHE_TTL.WATCH_HISTORY);
    return [...records];
  }

  private async getLeafLastPlayedAt(
    itemId: string,
  ): Promise<number | undefined> {
    const snapshot = this.getWatchSnapshot();
    if (snapshot) return snapshot.lastPlayedAt.get(itemId);

    // Newest ended first, so the first row answers the question.
    const { data } = await this.http!.get<
      SiloCollection<SiloPlaybackHistoryEntry>
    >('/admin/playback-history', {
      params: { media_item_id: itemId, limit: 1 },
    });
    this.assertItems(data, `playback history of ${itemId}`);
    const endedMs = data.items[0]
      ? new Date(data.items[0].ended_at).getTime()
      : NaN;
    return Number.isNaN(endedMs) ? undefined : endedMs;
  }

  private async getLeafPlayCount(itemId: string): Promise<number> {
    const snapshot = this.getWatchSnapshot();
    if (snapshot) return snapshot.plays.get(itemId) ?? 0;

    const entries = await this.readAllPages<SiloPlaybackHistoryEntry>(
      '/admin/playback-history',
      { media_item_id: itemId },
    );
    return entries.length;
  }

  /**
   * The ids that carry plays: a movie or episode itself, or every episode
   * under a show or season. Throws when the item or its children cannot be
   * read, since an empty list would read as "never watched".
   */
  private async getPlayableIds(itemId: string): Promise<string[]> {
    const item = await this.getMetadata(itemId);
    if (!item) {
      throw new Error(`Could not read Silo item ${itemId}`);
    }

    if (item.type === 'movie' || item.type === 'episode') {
      return [item.id];
    }

    const episodes = await this.getChildrenMetadata(
      item.id,
      item.type === 'show' ? 'episode' : undefined,
      true,
    );
    return episodes.map((episode) => episode.id);
  }

  async getActiveSessions(): Promise<Set<string>> {
    if (!this.http) return new Set<string>();
    try {
      const sessions =
        await this.readAllPages<SiloPlaybackSession>('/admin/sessions');
      const playing = new Set<string>();
      for (const session of sessions) {
        if (!session.content_id) continue;
        playing.add(session.content_id);
        // A collection can track an episode at any level, so protect its
        // season and show too.
        const item = await this.getMetadata(session.content_id);
        if (item?.parentId) playing.add(item.parentId);
        if (item?.grandparentId) playing.add(item.grandparentId);
      }
      return playing;
    } catch (error) {
      this.logger.warn('Failed to fetch active Silo sessions.');
      this.logger.debug(error);
      return new Set<string>();
    }
  }

  // ============================================================================
  // Collections
  // ============================================================================

  async getCollections(
    libraryId: string,
    useCache = true,
  ): Promise<MediaCollection[]> {
    if (!this.http) {
      throw new Error('Silo not initialized');
    }

    const cacheKey = `${SILO_CACHE_KEYS.COLLECTIONS}:${libraryId}`;
    // Still written back on a live read, so per-item reads stay warm.
    const cached = useCache
      ? this.cache.data.get<MediaCollection[]>(cacheKey)
      : undefined;
    if (cached) return cached;

    try {
      const collections = (
        await this.readList<SiloAdminCollection>('/admin/collections', {
          library_id: libraryId,
        })
      ).map(SiloMapper.toMediaCollection);
      this.cache.data.set(cacheKey, collections, SILO_CACHE_TTL.COLLECTIONS);
      return collections;
    } catch (error) {
      this.logger.error(
        `Silo getCollections(${libraryId}) failed: ${this.describeFailure(error)}`,
      );
      throw error;
    }
  }

  async getCollection(
    collectionId: string,
    throwOnError = false,
  ): Promise<MediaCollection | undefined> {
    if (!this.http) {
      if (throwOnError) {
        throw new Error('Silo not initialized');
      }
      return undefined;
    }

    try {
      const { data } = await this.http.get<SiloAdminCollection>(
        `/admin/collections/${encodeURIComponent(collectionId)}`,
      );
      return SiloMapper.toMediaCollection(data);
    } catch (error) {
      // A 404 is the server confirming the collection is gone; anything else
      // leaves its existence unknown, so throwOnError callers must not read it
      // as "missing" (#3344).
      if (isAxiosError(error) && error.response?.status === 404) {
        return undefined;
      }

      if (throwOnError) throw error;
      this.logger.debug(
        `Silo getCollection(${collectionId}) failed: ${this.describeFailure(error)}`,
      );
      return undefined;
    }
  }

  async createCollection(
    params: CreateCollectionParams,
  ): Promise<MediaCollection> {
    if (!this.http) throw new Error('Silo not initialized');

    // Silo's manual membership is drawn from its movies and shows. Refuse
    // before creating, rather than leave an empty collection behind that
    // every later add is refused from.
    if (params.type === 'season' || params.type === 'episode') {
      throw new Error(
        'Silo collections can only hold movies and shows. Keep season and episode collections in Maintainerr only.',
      );
    }

    let collection: MediaCollection;
    try {
      const { data } = await this.http.post<SiloAdminCollection>(
        '/admin/collections',
        {
          title: params.title,
          description: params.summary ?? '',
          library_id: params.libraryId,
        },
      );
      collection = SiloMapper.toMediaCollection(data);
    } catch (error) {
      const message = this.describeFailure(error);
      this.logger.warn(`Silo createCollection failed: ${message}`);
      throw new Error(`Failed to create Silo collection: ${message}`);
    }

    // The collection exists from here on; a stale listing would make the next
    // attempt create a second one.
    this.invalidateCollectionsCache(params.libraryId);

    if (params.initialItemId) {
      await this.addToCollection(collection.id, params.initialItemId);
      collection = { ...collection, childCount: collection.childCount + 1 };
    }
    return collection;
  }

  async deleteCollection(collectionId: string): Promise<void> {
    if (!this.http) throw new Error('Silo not initialized');
    try {
      await this.http.delete(
        `/admin/collections/${encodeURIComponent(collectionId)}`,
        // Silo guards writes with the collection's validator; "*" asks for the
        // delete whatever the current revision is.
        { headers: { 'If-Match': '*' } },
      );
      this.invalidateCollectionsCache();
    } catch (error) {
      const message = this.describeFailure(error);
      throw new Error(`Failed to delete Silo collection: ${message}`);
    }
  }

  /**
   * Maintainerr creates each collection in its rule group's library, so a
   * collection whose own library is `libraryId` holds nothing else. A
   * collection based in another library cannot say which members came from
   * this one, so it is left alone and reported as undecided.
   */
  async cleanupCollectionForLibrary(
    collectionId: string,
    libraryId: string,
    isManualCollection: boolean,
  ): Promise<void> {
    const collection = await this.getCollection(collectionId, true);
    if (!collection) return;

    if (collection.libraryId !== libraryId) {
      throw new Error(
        `Could not determine library membership for the children of collection ${collectionId}`,
      );
    }

    const children = await this.getCollectionChildren(collectionId);
    if (children.length > 0) {
      const { refused, unknown } = await this.removeBatchFromCollection(
        collectionId,
        children.map((child) => child.id),
      );
      if (refused.length > 0 || unknown.length > 0) {
        throw new Error(
          `Failed to remove ${refused.length + unknown.length} item(s) from collection ${collectionId}`,
        );
      }
    }

    if (!isManualCollection) {
      await this.deleteCollection(collectionId);
    }
  }

  async getCollectionChildren(collectionId: string): Promise<MediaItem[]> {
    if (!this.http) {
      throw new Error('Silo not initialized');
    }
    try {
      // Only manual membership can be listed. A smart collection derives its
      // members from a saved query and lists none here, which would read as
      // "every member was removed by hand", so its children are unknown.
      const collection = await this.getCollection(collectionId, true);
      if (collection?.smart) {
        throw new Error(
          `Silo collection ${collectionId} is a smart collection, whose members cannot be listed`,
        );
      }

      const members = await this.readAllPages<SiloAdminCollectionItem>(
        `/admin/collections/${encodeURIComponent(collectionId)}/items`,
      );
      const memberIds = members.map((member) => member.media_item_id);
      const resolved = new Map(
        (await this.getMetadataBatch(memberIds)).map((item) => [item.id, item]),
      );

      // Membership has to come back whole even when a member's metadata read
      // fails: callers reconcile against this list, and a member left out
      // reads as removed by hand.
      return members.map(
        (member) =>
          resolved.get(member.media_item_id) ??
          this.toMemberStub(member.media_item_id, member.title),
      );
    } catch (error) {
      this.logger.error(
        `Silo getCollectionChildren(${collectionId}) failed: ${this.describeFailure(error)}`,
      );
      // A swallowed enumeration failure reads as "the collection is empty"
      // downstream, which mass-resyncs rule-owned items.
      throw error;
    }
  }

  async addToCollection(collectionId: string, itemId: string): Promise<void> {
    const { refused, unknown } = await this.addBatchToCollection(collectionId, [
      itemId,
    ]);

    if (refused.length > 0 || unknown.length > 0) {
      throw new Error(
        `Failed to add item ${itemId} to collection ${collectionId}`,
      );
    }
  }

  async addBatchToCollection(
    collectionId: string,
    itemIds: string[],
  ): Promise<CollectionMutationOutcome> {
    return this.mutateCollection(collectionId, itemIds, (path) =>
      // Silo keeps an existing member's position; a new one goes first.
      this.http!.put(path, { position: 0 }),
    );
  }

  async removeFromCollection(
    collectionId: string,
    itemId: string,
  ): Promise<void> {
    const { refused, unknown } = await this.removeBatchFromCollection(
      collectionId,
      [itemId],
    );

    if (refused.length > 0 || unknown.length > 0) {
      throw new Error(
        `Failed to remove item ${itemId} from collection ${collectionId}`,
      );
    }
  }

  async removeBatchFromCollection(
    collectionId: string,
    itemIds: string[],
  ): Promise<CollectionMutationOutcome> {
    return this.mutateCollection(collectionId, itemIds, (path) =>
      this.http!.delete(path),
    );
  }

  /**
   * Silo adds and removes one member per request, so a batch is a bounded
   * fan-out, each id answered on its own.
   */
  private async mutateCollection(
    collectionId: string,
    itemIds: string[],
    mutate: (path: string) => Promise<unknown>,
  ): Promise<CollectionMutationOutcome> {
    const outcome: CollectionMutationOutcome = { refused: [], unknown: [] };
    if (itemIds.length === 0) return outcome;
    if (!this.http) return { refused: [], unknown: [...itemIds] };

    for (const batch of chunk(itemIds, SILO_BATCH_SIZE.COLLECTION_MUTATION)) {
      await Promise.all(
        batch.map(async (itemId) => {
          try {
            await mutate(
              `/admin/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`,
            );
          } catch (error) {
            this.logger.debug(
              `Silo collection mutation for ${itemId} failed: ${this.describeFailure(error)}`,
            );
            recordMutationFailure(
              outcome,
              [itemId],
              classifyMutationError(error),
            );
          }
        }),
      );
    }

    if (outcome.refused.length > 0 || outcome.unknown.length > 0) {
      this.logger.warn(
        `Silo collection ${collectionId}: ${outcome.refused.length} refused, ${outcome.unknown.length} unconfirmed of ${itemIds.length} item(s)`,
      );
    }
    return outcome;
  }

  async updateCollection(
    params: UpdateCollectionParams,
  ): Promise<MediaCollection> {
    if (!this.http) throw new Error('Silo not initialized');
    try {
      // Silo has no sort title on a collection, so sortTitle has nowhere to go.
      const { data } = await this.http.patch<SiloAdminCollection>(
        `/admin/collections/${encodeURIComponent(params.collectionId)}`,
        {
          ...(params.title !== undefined ? { title: params.title } : {}),
          ...(params.summary !== undefined
            ? { description: params.summary }
            : {}),
        },
        { headers: { 'If-Match': '*' } },
      );
      this.invalidateCollectionsCache(params.libraryId);
      return SiloMapper.toMediaCollection(data);
    } catch (error) {
      const message = this.describeFailure(error);
      throw new Error(`Failed to update Silo collection: ${message}`);
    }
  }

  async updateCollectionVisibility(
    settings: CollectionVisibilitySettings,
  ): Promise<void> {
    void settings;
    throw new Error(
      'updateCollectionVisibility is not supported on Silo (Plex-only feature)',
    );
  }

  async reorderCollectionItems(
    collectionId: string,
    orderedItemIds: string[],
  ): Promise<void> {
    void collectionId;
    void orderedItemIds;
    // Gated by supportsFeature(COLLECTION_SORT), which is false for Silo.
    throw new Error('Collection sort is not supported on Silo yet');
  }

  async setCollectionImage(
    collectionId: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<void> {
    void collectionId;
    void buffer;
    void contentType;
    // Gated by supportsFeature(COLLECTION_POSTER), which is false for Silo.
    throw new Error('Collection posters are not supported on Silo yet');
  }

  private invalidateCollectionsCache(libraryId?: string): void {
    if (libraryId) {
      this.cache.data.del(`${SILO_CACHE_KEYS.COLLECTIONS}:${libraryId}`);
      return;
    }
    const prefix = `${SILO_CACHE_KEYS.COLLECTIONS}:`;
    const stale = this.cache.data
      .keys()
      .filter((key) => key.startsWith(prefix));
    if (stale.length > 0) this.cache.data.del(stale);
  }

  // ============================================================================
  // Playlists
  // ============================================================================

  // Silo has no playlists.
  async getPlaylists(): Promise<MediaPlaylist[]> {
    return [];
  }

  // ============================================================================
  // Destructive
  // ============================================================================

  async deleteFromDisk(itemId: string): Promise<void> {
    // Silo mounts media read-only and never deletes files, so there is
    // nothing to ask it. Callers only reach this when Radarr or Sonarr could
    // not find the item to delete it themselves.
    throw new Error(
      `Silo cannot delete files from disk (item ${itemId}). Delete it through Radarr or Sonarr instead.`,
    );
  }

  // ============================================================================
  // Context-action ID resolution
  // ============================================================================

  async getAllIdsForContextAction(
    collectionType: MediaItemType | undefined,
    context: { type: MediaItemType; id: string },
    mediaId: string,
  ): Promise<string[]> {
    return resolveContextActionIds(
      collectionType,
      context,
      mediaId,
      (parentId, type) => this.getChildrenMetadata(parentId, type, true),
      (message) => this.logger.warn(message),
    );
  }

  // ============================================================================
  // Cache management
  // ============================================================================

  // The item id is ignored: an item's metadata, its children and its parents'
  // season lookups all hang off it, so a full flush is the simplest correct
  // reset. Watch history is unaffected; it never comes from this cache alone.
  resetMetadataCache(): void {
    this.cache.flush();
  }

  async refreshItemMetadata(itemId: string): Promise<void> {
    if (!this.http) {
      throw new Error('Silo not initialized');
    }
    try {
      await this.http.post(
        `/admin/items/${encodeURIComponent(itemId)}/refresh-metadata`,
        { mode: 'quick' },
      );
    } catch (error) {
      this.logger.error(
        `Silo refreshItemMetadata(${itemId}) failed: ${this.describeFailure(error)}`,
      );
      throw error;
    }
  }

  async scanFolder(libraryId: string, folderPath: string): Promise<void> {
    if (!this.http) {
      throw new Error('Silo not initialized');
    }
    await this.http.post('/scan', { library_id: libraryId, path: folderPath });
  }

  // ============================================================================
  // Internal helpers
  // ============================================================================

  /**
   * Every item of a cursor-paginated collection. Only for routes that take
   * `limit` and `cursor`; see readList for the rest. A page without an item list
   * is a broken read, and one that claims more without a cursor would loop or
   * stop short, so both throw rather than answer a partial list.
   */
  private async readAllPages<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    abortSignal?: AbortSignal,
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;

    do {
      abortSignal?.throwIfAborted();
      const { data } = await this.http!.get<SiloCollection<T>>(path, {
        params: {
          ...params,
          limit: SILO_BATCH_SIZE.MAX_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
        signal: abortSignal,
      });
      this.assertItems(data, path);
      items.push(...data.items);

      const nextCursor = data.page?.has_more
        ? data.page.next_cursor
        : undefined;
      if (data.page?.has_more && !nextCursor) {
        throw new Error(`Silo ${path} claimed more items without a cursor`);
      }
      cursor = nextCursor;
    } while (cursor);

    return items;
  }

  /**
   * A bounded collection Silo answers whole. Silo refuses query parameters
   * a route does not declare (HTTP 422), so these routes are never sent the
   * paging parameters readAllPages adds.
   */
  private async readList<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T[]> {
    const { data } = await this.http!.get<SiloCollection<T>>(path, { params });
    this.assertItems(data, path);
    if (data.page?.has_more) {
      throw new Error(`Silo ${path} claimed more items than it returned`);
    }
    return data.items;
  }

  /**
   * The connection failure, plus what Silo said was wrong. Silo answers
   * errors as RFC 9457 problem details, and a bare "422" names nothing.
   */
  private describeFailure(error: unknown): string {
    const message = formatConnectionFailureMessage(error, 'Connection failed');
    const problem = isAxiosError(error)
      ? (error.response?.data as SiloProblem | undefined)
      : undefined;
    if (!problem || typeof problem !== 'object') return message;

    const details = (problem.errors ?? [])
      .map((detail) =>
        [detail.location, detail.detail].filter(Boolean).join(': '),
      )
      .filter((detail) => detail.length > 0);
    const summary = details.length > 0 ? details.join('; ') : problem.detail;
    return summary || problem.title
      ? `${message} (${[problem.title, summary].filter(Boolean).join(' - ')})`
      : message;
  }

  private assertItems<T>(
    data: SiloCollection<T> | undefined,
    what: string,
  ): asserts data is SiloCollection<T> {
    if (!Array.isArray(data?.items)) {
      throw new Error(`Silo returned ${what} without an item list`);
    }
  }

  private async readCatalogPage(
    params: Record<string, string | number | undefined>,
  ): Promise<SiloCatalogPage> {
    const { data } = await this.http!.get<SiloCatalogPage>('/catalog', {
      params,
    });
    this.assertItems(data, 'a catalog page');
    if (!Number.isSafeInteger(data.total) || data.total < 0) {
      throw new Error('Silo returned an invalid catalog total');
    }
    return data;
  }

  /**
   * The catalog `type` scope for a listing. Without an explicit type a movie
   * library lists its movies and a series library its shows, matching what
   * the other adapters answer for an untyped library read.
   */
  private async catalogTypeFor(
    libraryId: string,
    type?: MediaItemType,
  ): Promise<string> {
    if (type) return SiloMapper.toCatalogType(type);
    const library = (await this.getLibraries()).find(
      (candidate) => candidate.id === libraryId,
    );
    return library?.type === 'show' ? 'series' : 'movie';
  }

  private async getLibraryRef(
    libraryId: string,
  ): Promise<{ id: string; title: string }> {
    const library = (await this.getLibraries()).find(
      (candidate) => candidate.id === libraryId,
    );
    return { id: libraryId, title: library?.title ?? '' };
  }

  /**
   * Maps catalog rows, resolving each episode's season id. An episode row
   * names its series and season number only, and every season of a series
   * comes from one cached read, so a page costs one read per series at most.
   */
  private async toMediaItems(
    rows: SiloCatalogItem[],
    library?: { id: string; title: string },
  ): Promise<MediaItem[]> {
    const items: MediaItem[] = [];
    for (const row of rows) {
      const seasonId =
        row.type === 'episode' && row.series_id
          ? await this.getSeasonId(row.series_id, row.season_number)
          : undefined;
      items.push(SiloMapper.toMediaItem(row, { seasonId, library }));
      this.rememberListing(row, library);
    }
    return items;
  }

  /** Keep what a listing card knows that a detail read does not. */
  private rememberListing(
    row: SiloCatalogItem,
    library?: { id: string; title: string },
  ): void {
    if (!row.added_at && !library) return;
    this.cache.data.set<ListedItem>(
      `${SILO_CACHE_KEYS.LISTED}:${row.content_id}`,
      { addedAt: row.added_at, library },
      SILO_CACHE_TTL.LIBRARY_SEASONS,
    );
  }

  /** The content id of season `seasonNumber` of a series, from one cached read. */
  private async getSeasonId(
    seriesId: string,
    seasonNumber: number | undefined,
  ): Promise<string | undefined> {
    if (seasonNumber === undefined) return undefined;

    const cacheKey = `${SILO_CACHE_KEYS.SEASON_IDS}:${seriesId}`;
    let seasonIds = this.cache.data.get<Record<number, string>>(cacheKey);
    if (!seasonIds) {
      seasonIds = {};
      for (const season of await this.readSeasonRows(seriesId)) {
        seasonIds[season.season_number] = season.content_id;
      }
      this.cache.data.set(cacheKey, seasonIds, SILO_CACHE_TTL.METADATA);
    }
    return seasonIds[seasonNumber];
  }

  private async readSeasonRows(seriesId: string): Promise<SiloSeason[]> {
    return this.readList<SiloSeason>(
      `/catalog/series/${encodeURIComponent(seriesId)}/seasons`,
    );
  }

  private async readSeasons(
    series: SiloCatalogItem,
    library?: { id: string; title: string },
  ): Promise<MediaItem[]> {
    return (await this.readSeasonRows(series.content_id)).map((season) =>
      SiloMapper.toSeasonItem(
        season,
        { id: series.content_id, title: series.title },
        library,
      ),
    );
  }

  private async readEpisodes(seasonId: string): Promise<MediaItem[]> {
    const rows = await this.readList<SiloCatalogItem>(
      `/catalog/items/${encodeURIComponent(seasonId)}/episodes`,
    );
    return rows.map((row) => {
      this.rememberListing(row);
      return SiloMapper.toMediaItem(row, { seasonId });
    });
  }

  private async readEpisodesOfSeasons(
    seasons: MediaItem[],
  ): Promise<MediaItem[]> {
    const episodes: MediaItem[] = [];
    for (const batch of chunk(seasons, SILO_BATCH_SIZE.SERIES_SEASONS)) {
      const results = await Promise.all(
        batch.map((season) => this.readEpisodes(season.id)),
      );
      for (const result of results) episodes.push(...result);
    }
    return episodes;
  }

  /**
   * Every season in a library, in show order. Silo's catalog has no season
   * scope, so the list is built from the library's shows and kept for the
   * run, which pages through it one window at a time.
   */
  private async getLibrarySeasons(libraryId: string): Promise<MediaItem[]> {
    const cacheKey = `${SILO_CACHE_KEYS.LIBRARY_SEASONS}:${libraryId}`;
    const cached = this.cache.data.get<MediaItem[]>(cacheKey);
    if (cached) return cached;

    const library = await this.getLibraryRef(libraryId);
    const series = await this.readAllPages<SiloCatalogItem>('/catalog', {
      library_id: libraryId,
      type: 'series',
      sort: 'title',
    });

    const seasons: MediaItem[] = [];
    for (const batch of chunk(series, SILO_BATCH_SIZE.SERIES_SEASONS)) {
      const results = await Promise.all(
        batch.map((show) => this.readSeasons(show, library)),
      );
      for (const result of results) seasons.push(...result);
    }

    this.cache.data.set(cacheKey, seasons, SILO_CACHE_TTL.LIBRARY_SEASONS);
    return seasons;
  }

  /**
   * A collection member whose metadata could not be read. Silo content ids
   * lead with their kind, which is enough to keep the member's type.
   */
  private toMemberStub(itemId: string, title?: string): MediaItem {
    return {
      id: itemId,
      title: title ?? '',
      guid: itemId,
      type: itemId.startsWith('series-') ? 'show' : 'movie',
      addedAt: new Date(NaN),
      providerIds: {},
      mediaSources: [],
      library: { id: '', title: '' },
    };
  }

  private toSiloSort(
    sort?: MediaLibrarySortField,
    sortOrder?: 'asc' | 'desc',
  ): string {
    let field: string;
    switch (sort) {
      case 'airDate':
        field = 'release_date';
        break;
      case 'addedAt':
        field = 'added_at';
        break;
      case 'rating':
        field = 'rating';
        break;
      default:
        // Title is also the stable order the rule executor pages by.
        field = 'title';
    }
    return sortOrder === 'desc' ? `-${field}` : field;
  }
}
