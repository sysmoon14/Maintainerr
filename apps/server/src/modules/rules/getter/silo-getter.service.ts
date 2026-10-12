import {
  isMediaType,
  MediaItem,
  MediaItemType,
  RuleValueType,
  WatchRecord,
} from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import cacheManager, { Cache } from '../../api/lib/cache';
import { SiloAdapterService } from '../../api/media-server/silo/silo-adapter.service';
import { MaintainerrLogger } from '../../logging/logs.service';
import {
  Application,
  Property,
  RuleConstants,
} from '../constants/rules.constants';
import { RuleGroupDto } from '../dtos/ruleGroup.dto';
import { ArrLookupCache } from '../helpers/arr-lookup-cache';
import {
  filterRuleCollectionNames,
  getParentBackedRuleItem,
  isValidDate,
  isWatchedAfter,
  mapRuleUserIdsToNames,
  requireRuleParent,
} from '../helpers/rule-property.helper';
import { MetadataRuleValueService } from './metadata-rule-value.service';

/**
 * Silo Getter Service
 *
 * Implements the Jellyfin property set Silo can answer (see the Silo entry in
 * RuleConstants), with the Emby getter's structure.
 *
 * Silo-specific notes:
 * - Users are household profiles; every name a rule compares is a profile
 *   name.
 * - A show or season has no plays of its own, so its watch history is its
 *   episodes' history, the way Plex reads a show. `seenBy` on a show is
 *   everyone who finished any episode; `sw_allEpisodesSeenBy` is the
 *   finished-every-episode reading.
 * - Watched means a finished play or a completed mark (by hand or from a
 *   history import). Marks, favourites and watchlists are only readable for
 *   profiles of the API key's account; see the adapter's model notes.
 */
interface StoredCollection {
  id: string;
  title: string;
  memberIds: string[];
}

// Collections read in parallel while a rule run builds its membership map.
const COLLECTION_READ_CONCURRENCY = 4;

@Injectable()
export class SiloGetterService {
  siloProperties: Property[];
  private readonly cache: Cache;
  // One in-flight collection sweep per library, shared by every item the
  // executor evaluates concurrently.
  private readonly collectionReads = new Map<
    string,
    Promise<StoredCollection[]>
  >();

  constructor(
    private readonly siloAdapter: SiloAdapterService,
    private readonly metadataRuleValueService: MetadataRuleValueService,
    private readonly logger: MaintainerrLogger,
  ) {
    logger.setContext(SiloGetterService.name);
    const ruleConstants = new RuleConstants();
    this.siloProperties =
      ruleConstants.applications.find((el) => el.id === Application.SILO)
        ?.props ?? [];
    this.cache = cacheManager.getCache('silo');
  }

  async get(
    id: number,
    libItem: MediaItem,
    dataType?: MediaItemType,
    ruleGroup?: RuleGroupDto,
    arrLookupCache?: ArrLookupCache,
  ): Promise<RuleValueType> {
    try {
      if (!this.siloAdapter.isSetup()) {
        this.logger.warn('Silo service is not configured');
        return null;
      }

      const prop = this.siloProperties.find((el) => el.id === id);
      if (!prop) {
        this.logger.warn(`Unknown or unsupported Silo property ID: ${id}`);
        return null;
      }

      if (prop.name === 'studios') {
        return await this.metadataRuleValueService.getStudios(
          libItem,
          arrLookupCache,
        );
      }

      const metadata = await this.siloAdapter.getMetadata(libItem.id);

      if (!metadata) {
        this.logger.warn(`Failed to get Silo metadata for item ${libItem.id}`);
        // undefined, not null: getMetadata answers undefined for both a
        // missing item and a failed read, and null is the comparator's
        // "confirmed absent" signal (#3125).
        return undefined;
      }

      let parentPromise: Promise<MediaItem | undefined> | undefined;
      const getParent = async () => {
        if (!metadata.parentId) return undefined;
        parentPromise ??= this.siloAdapter.getMetadata(metadata.parentId);
        return parentPromise;
      };

      let grandparentPromise: Promise<MediaItem | undefined> | undefined;
      const getGrandparent = async () => {
        if (!metadata.grandparentId) return undefined;
        grandparentPromise ??= this.siloAdapter.getMetadata(
          metadata.grandparentId,
        );
        return grandparentPromise;
      };

      // The show a season/episode belongs to; undefined for anything else, so
      // the `*Show` properties answer `null` (does not apply).
      const getShowMetadata = async () =>
        isMediaType(metadata.type, 'season') ||
        isMediaType(metadata.type, 'episode')
          ? getParentBackedRuleItem(
              metadata.type,
              metadata,
              getParent,
              getGrandparent,
            )
          : undefined;

      switch (prop.name) {
        case 'addDate': {
          return isValidDate(metadata.addedAt)
            ? new Date(metadata.addedAt)
            : null;
        }

        case 'seenBy': {
          return this.toUserNames(
            await this.siloAdapter.getItemSeenBy(metadata.id),
          );
        }

        case 'releaseDate': {
          return metadata.originallyAvailableAt
            ? new Date(metadata.originallyAvailableAt)
            : null;
        }

        case 'rating_critics': {
          return this.rating(metadata, 'rottenTomatoes', 'critic') ?? 0;
        }

        case 'rating_audience': {
          return (
            this.rating(metadata, 'tmdb', 'audience') ??
            this.rating(metadata, 'imdb', 'audience') ??
            0
          );
        }

        case 'people': {
          return metadata.actors?.map((actor) => actor.name) ?? null;
        }

        case 'viewCount': {
          const watchState = await this.siloAdapter.getWatchState(metadata.id);
          return watchState.viewCount;
        }

        case 'isWatched': {
          const watchState = await this.siloAdapter.getWatchState(metadata.id);
          return watchState.isWatched;
        }

        case 'playCount':
        case 'sw_playCount': {
          // Every play, unfinished ones included.
          return await this.siloAdapter.getTotalPlayCount(metadata.id);
        }

        case 'collections': {
          const collectionNames = await this.getCollectionNames(
            metadata.id,
            ruleGroup.libraryId,
            ruleGroup,
          );
          return collectionNames.length;
        }

        case 'collection_names': {
          return await this.getCollectionNames(
            metadata.id,
            ruleGroup.libraryId,
            ruleGroup,
          );
        }

        case 'lastViewedAt': {
          return this.newestWatch(
            await this.siloAdapter.getWatchHistory(metadata.id),
          );
        }

        case 'lastPlayedAt': {
          return await this.siloAdapter.getLastPlayedAt(metadata.id);
        }

        case 'fileVideoResolution': {
          return metadata.mediaSources?.[0]?.videoResolution ?? null;
        }

        case 'fileBitrate': {
          return metadata.mediaSources?.[0]?.bitrate ?? 0;
        }

        case 'fileVideoCodec': {
          return metadata.mediaSources?.[0]?.videoCodec ?? null;
        }

        case 'genre': {
          // For episodes/seasons, get genres from the show
          const item = await getParentBackedRuleItem(
            metadata.type,
            metadata,
            getParent,
            getGrandparent,
          );
          return item.genres?.map((genre) => genre.name) ?? [];
        }

        case 'sw_allEpisodesSeenBy':
        case 'sw_allEpisodesSeenBySinceAdded': {
          return await this.getAllEpisodesSeenBy(
            metadata.id,
            metadata.type,
            prop.name === 'sw_allEpisodesSeenBySinceAdded'
              ? this.getAddedAtCutoff(metadata.addedAt)
              : undefined,
          );
        }

        case 'sw_lastWatched': {
          return await this.getNewestWatchedEpisodeDate(
            metadata.id,
            metadata.type,
          );
        }

        case 'sw_lastViewedAtThroughSeason': {
          // Does not apply is an answer, not a failed read (#3402).
          if (metadata.type !== 'season') {
            return null;
          }
          return await this.getLastViewedAtThroughSeason(
            metadata,
            arrLookupCache,
          );
        }

        case 'sw_episodes': {
          return (await this.getEpisodes(metadata.id, metadata.type)).length;
        }

        case 'sw_viewedEpisodes': {
          const watchHistory = await this.descendantWatchHistory(
            metadata.id,
            metadata.type,
          );
          return Object.values(watchHistory).filter(
            (records) => records.length > 0,
          ).length;
        }

        case 'sw_lastEpisodeAddedAt': {
          return this.newestDate(
            (await this.getEpisodes(metadata.id, metadata.type)).map(
              (episode) => episode.addedAt,
            ),
          );
        }

        case 'sw_amountOfViews': {
          return (await this.siloAdapter.getWatchHistory(metadata.id)).length;
        }

        // At season/show level this returns the UNION of profiles that
        // finished any descendant episode, as on every other server. Use
        // `sw_allEpisodesSeenBy` for "watched every episode".
        case 'sw_watchers':
        case 'sw_watchersSinceAdded': {
          return await this.getSwWatchers(
            metadata.id,
            metadata.type,
            prop.name === 'sw_watchersSinceAdded'
              ? this.getAddedAtCutoff(metadata.addedAt)
              : undefined,
          );
        }

        case 'sw_collections_including_parent': {
          return (
            await this.getCollectionNamesIncludingParent(
              metadata,
              ruleGroup.libraryId,
              ruleGroup,
            )
          ).length;
        }

        case 'sw_collection_names_including_parent': {
          return await this.getCollectionNamesIncludingParent(
            metadata,
            ruleGroup.libraryId,
            ruleGroup,
          );
        }

        case 'sw_lastEpisodeAiredAt': {
          return this.newestDate(
            (await this.getEpisodes(metadata.id, metadata.type)).map(
              (episode) => episode.originallyAvailableAt,
            ),
          );
        }

        case 'sw_seasonLastEpisodeAiredAt': {
          const parent = requireRuleParent(await getParent());
          return this.newestDate(
            (await this.getEpisodes(parent.id, 'season')).map(
              (episode) => episode.originallyAvailableAt,
            ),
          );
        }

        case 'rating_imdb': {
          return this.rating(metadata, 'imdb', 'audience') ?? null;
        }

        case 'rating_tmdb': {
          return this.rating(metadata, 'tmdb', 'audience') ?? null;
        }

        case 'rating_rottenTomatoesCritic': {
          return this.rating(metadata, 'rottenTomatoes', 'critic') ?? null;
        }

        case 'rating_rottenTomatoesAudience': {
          return this.rating(metadata, 'rottenTomatoes', 'audience') ?? null;
        }

        case 'rating_imdbShow': {
          const show = await getShowMetadata();
          return show ? (this.rating(show, 'imdb', 'audience') ?? null) : null;
        }

        case 'rating_tmdbShow': {
          const show = await getShowMetadata();
          return show ? (this.rating(show, 'tmdb', 'audience') ?? null) : null;
        }

        case 'rating_rottenTomatoesCriticShow': {
          const show = await getShowMetadata();
          return show
            ? (this.rating(show, 'rottenTomatoes', 'critic') ?? null)
            : null;
        }

        case 'rating_rottenTomatoesAudienceShow': {
          const show = await getShowMetadata();
          return show
            ? (this.rating(show, 'rottenTomatoes', 'audience') ?? null)
            : null;
        }

        case 'favoritedBy':
        case 'sw_favoritedBy': {
          return this.toUserNames(
            await this.siloAdapter.getItemFavoritedBy([metadata.id]),
          );
        }

        case 'sw_favoritedBy_including_parent': {
          return this.toUserNames(
            await this.siloAdapter.getItemFavoritedBy(
              SiloGetterService.selfAndParents(metadata),
            ),
          );
        }

        case 'isInWatchlist': {
          return (
            (await this.siloAdapter.getItemWatchlistedBy([metadata.id]))
              .length > 0
          );
        }

        case 'watchlistedByUsers': {
          return this.toUserNames(
            await this.siloAdapter.getItemWatchlistedBy([metadata.id]),
          );
        }

        case 'isInWatchlist_including_parent': {
          return (
            (
              await this.siloAdapter.getItemWatchlistedBy(
                SiloGetterService.selfAndParents(metadata),
              )
            ).length > 0
          );
        }

        case 'watchlistedByUsers_including_parent': {
          return this.toUserNames(
            await this.siloAdapter.getItemWatchlistedBy(
              SiloGetterService.selfAndParents(metadata),
            ),
          );
        }

        case 'collection_siblings_lastViewedAt': {
          return await this.getCollectionSiblingsLastViewedAt(
            metadata.id,
            ruleGroup.libraryId,
            ruleGroup,
          );
        }

        default: {
          this.logger.warn(`Unhandled Silo property: ${prop.name}`);
          return null;
        }
      }
    } catch (error) {
      this.logger.warn(
        `Silo-Getter - Action failed for '${libItem.title}' with id '${libItem.id}'`,
      );
      this.logger.debug(error);
      return undefined;
    }
  }

  /**
   * The item and the parents it carries. Reading the parents would only add
   * a way to fail (#3877).
   */
  private static selfAndParents(item: MediaItem): string[] {
    return [item.id, item.parentId, item.grandparentId].filter(
      (id): id is string => Boolean(id),
    );
  }

  private rating(
    item: MediaItem,
    source: string,
    type: 'audience' | 'critic',
  ): number | undefined {
    return item.ratings?.find(
      (rating) => rating.source === source && rating.type === type,
    )?.value;
  }

  private async toUserNames(userIds: string[]): Promise<string[]> {
    const users = await this.siloAdapter.getUsers();
    return mapRuleUserIdsToNames(
      userIds,
      users,
      (user) => user.id,
      (user) => user.name,
    );
  }

  private newestWatch(records: WatchRecord[]): Date | null {
    return this.newestDate(records.map((record) => record.watchedAt));
  }

  private newestDate(dates: Array<Date | undefined>): Date | null {
    let newest: Date | null = null;
    for (const date of dates) {
      if (date && isValidDate(date) && (!newest || date > newest)) {
        newest = date;
      }
    }
    return newest;
  }

  private getAddedAtCutoff(addedAt: Date): Date {
    if (!isValidDate(addedAt)) {
      throw new Error('Silo metadata has an invalid addedAt timestamp');
    }
    return addedAt;
  }

  /** The episodes of a show or season; an episode is its own only episode. */
  private async getEpisodes(
    itemId: string,
    type: MediaItemType,
  ): Promise<MediaItem[]> {
    if (isMediaType(type, 'show') || isMediaType(type, 'season')) {
      return this.siloAdapter.getChildrenMetadata(
        itemId,
        isMediaType(type, 'show') ? 'episode' : undefined,
        true,
      );
    }
    return [];
  }

  private async descendantWatchHistory(
    itemId: string,
    type: MediaItemType,
    watchedAfter?: Date,
  ): Promise<Record<string, WatchRecord[]>> {
    if (!isMediaType(type, 'show') && !isMediaType(type, 'season')) {
      return {};
    }

    const watchHistory =
      await this.siloAdapter.getDescendantEpisodeWatchHistory(
        itemId,
        isMediaType(type, 'season') ? 'season' : 'show',
      );

    if (watchedAfter === undefined) return watchHistory;

    return Object.fromEntries(
      Object.entries(watchHistory).map(([episodeId, records]) => [
        episodeId,
        records.filter((record) => isWatchedAfter(record, watchedAfter)),
      ]),
    );
  }

  private async getAllEpisodesSeenBy(
    itemId: string,
    type: MediaItemType,
    watchedAfter?: Date,
  ): Promise<string[]> {
    const users = await this.siloAdapter.getUsers(watchedAfter !== undefined);
    const episodeWatchers = Object.values(
      await this.descendantWatchHistory(itemId, type, watchedAfter),
    );

    if (episodeWatchers.length === 0) return [];

    // Profiles that appear in EVERY episode's watch list
    const usersWhoWatchedAll = users
      .map((user) => user.id)
      .filter((userId) =>
        episodeWatchers.every((records) =>
          records.some((record) => record.userId === userId),
        ),
      );

    return mapRuleUserIdsToNames(
      usersWhoWatchedAll,
      users,
      (user) => user.id,
      (user) => user.name,
    );
  }

  private async getSwWatchers(
    itemId: string,
    type: MediaItemType,
    watchedAfter?: Date,
  ): Promise<string[]> {
    if (
      !isMediaType(type, 'episode') &&
      !isMediaType(type, 'season') &&
      !isMediaType(type, 'show')
    ) {
      return [];
    }

    const records = await this.siloAdapter.getWatchHistory(itemId);
    const watcherIds = new Set(
      records
        .filter(
          (record) =>
            watchedAfter === undefined || isWatchedAfter(record, watchedAfter),
        )
        .map((record) => record.userId),
    );

    const users = await this.siloAdapter.getUsers(watchedAfter !== undefined);
    return mapRuleUserIdsToNames(
      users.map((user) => user.id).filter((userId) => watcherIds.has(userId)),
      users,
      (user) => user.id,
      (user) => user.name,
    );
  }

  /**
   * The view date of the highest-numbered watched episode in the
   * highest-numbered season with any watches. Matches the Plex/Tautulli
   * `sw_lastWatched` semantic: "view date of the newest watched episode".
   */
  private async getNewestWatchedEpisodeDate(
    itemId: string,
    type: MediaItemType,
  ): Promise<Date | null> {
    const episodes = await this.getEpisodes(itemId, type);
    const watchHistory = await this.descendantWatchHistory(itemId, type);

    let newest:
      { parentIndex: number; index: number; viewedAt: Date } | undefined;
    for (const episode of episodes) {
      const order = episode.indexEnd ?? episode.index;
      if (order === undefined || episode.parentIndex === undefined) continue;

      const viewedAt = this.newestWatch(watchHistory[episode.id] ?? []);
      if (!viewedAt) continue;

      if (
        !newest ||
        episode.parentIndex > newest.parentIndex ||
        (episode.parentIndex === newest.parentIndex && order > newest.index)
      ) {
        newest = { parentIndex: episode.parentIndex, index: order, viewedAt };
      }
    }

    return newest?.viewedAt ?? null;
  }

  /**
   * The newest view of any episode in this season or an earlier one. Season 0
   * (specials) only counts itself.
   */
  private async getLastViewedAtThroughSeason(
    season: MediaItem,
    arrLookupCache?: ArrLookupCache,
  ): Promise<Date | null> {
    const targetSeason = season.index;
    const showId = season.parentId;
    if (
      targetSeason === undefined ||
      !Number.isSafeInteger(targetSeason) ||
      targetSeason < 0 ||
      !showId
    ) {
      throw new Error('Silo season metadata is missing its valid scope');
    }

    const readSeasons = () =>
      this.siloAdapter.getChildrenMetadata(showId, 'season', true);
    const seasons = await (arrLookupCache?.memoize(
      `silo:show-seasons:${showId}`,
      readSeasons,
    ) ?? readSeasons());

    let latest: Date | null = null;
    for (const candidate of seasons) {
      const seasonIndex = candidate.index;
      if (seasonIndex === undefined) continue;

      const qualifies =
        targetSeason === 0
          ? seasonIndex === 0
          : seasonIndex > 0 && seasonIndex <= targetSeason;
      if (!qualifies) continue;

      const readWatchedAt = async () =>
        this.newestWatch(await this.siloAdapter.getWatchHistory(candidate.id));
      const watchedAt = await (arrLookupCache?.memoize(
        `silo:season-view-date:${candidate.id}`,
        readWatchedAt,
      ) ?? readWatchedAt());
      if (watchedAt && (!latest || watchedAt > latest)) {
        latest = watchedAt;
      }
    }

    return latest;
  }

  private async getCollectionNames(
    itemId: string,
    libraryId: string,
    ruleGroup?: RuleGroupDto,
  ): Promise<string[]> {
    return filterRuleCollectionNames(
      await this.getCollectionsHolding([itemId], libraryId),
      ruleGroup,
    );
  }

  private async getCollectionNamesIncludingParent(
    item: MediaItem,
    libraryId: string,
    ruleGroup?: RuleGroupDto,
  ): Promise<string[]> {
    // The item carries its parents' ids; reading them would only add a way to
    // fail and drop their collections (#3877).
    const ids = [item.id, item.parentId, item.grandparentId].filter(
      (id): id is string => id !== undefined,
    );
    return [
      ...new Set(
        filterRuleCollectionNames(
          await this.getCollectionsHolding(ids, libraryId),
          ruleGroup,
        ),
      ),
    ];
  }

  /**
   * The library's collections with their member ids, read once per rule run
   * (cacheManager.flushAll() clears the cache at the start of every run)
   * rather than once per evaluated item. Manual and imported (Trakt, MDBList,
   * TMDB) collections count.
   *
   * Smart collections are left out: their members are a live query rather
   * than a curated set, like the smart collections the Plex getter's
   * `collections` property skips.
   */
  private async getStoredCollections(
    libraryId: string,
  ): Promise<Array<{ id: string; title: string; memberIds: Set<string> }>> {
    const cacheKey = `silo:rule-collections:${libraryId}`;
    const cached = this.cache.data.get<StoredCollection[]>(cacheKey);
    if (cached) return SiloGetterService.withMemberSets(cached);

    // The executor evaluates many items at once. Without sharing the read,
    // every item that misses the cache starts its own sweep of every
    // collection, and Silo answers the burst with 429s.
    let pending: Promise<StoredCollection[]> | undefined =
      this.collectionReads.get(libraryId);
    if (pending === undefined) {
      pending = this.readStoredCollections(libraryId)
        .then((collections) => {
          this.cache.data.set(cacheKey, collections, 600);
          return collections;
        })
        .finally(() => this.collectionReads.delete(libraryId));
      this.collectionReads.set(libraryId, pending);
    }

    return SiloGetterService.withMemberSets(await pending);
  }

  private async readStoredCollections(
    libraryId: string,
  ): Promise<StoredCollection[]> {
    const listed = (await this.siloAdapter.getCollections(libraryId)).filter(
      (collection) => !collection.smart,
    );

    const collections: StoredCollection[] = [];
    for (let i = 0; i < listed.length; i += COLLECTION_READ_CONCURRENCY) {
      collections.push(
        ...(await Promise.all(
          listed
            .slice(i, i + COLLECTION_READ_CONCURRENCY)
            .map(async (collection) => ({
              id: collection.id,
              title: collection.title.trim(),
              memberIds: await this.siloAdapter.getCollectionMemberIds(
                collection.id,
              ),
            })),
        )),
      );
    }

    this.logger.debug(
      `Silo library ${libraryId} collections counted by rules: ${
        collections
          .map(
            (collection) =>
              `'${collection.title}' (${collection.id}, ${collection.memberIds.length} members)`,
          )
          .join(', ') || 'none'
      }`,
    );
    return collections;
  }

  private static withMemberSets(
    collections: StoredCollection[],
  ): Array<{ id: string; title: string; memberIds: Set<string> }> {
    return collections.map((collection) => ({
      ...collection,
      memberIds: new Set(collection.memberIds),
    }));
  }

  /** Titles of the library's collections holding any of `itemIds`. */
  private async getCollectionsHolding(
    itemIds: string[],
    libraryId: string,
  ): Promise<string[]> {
    return (await this.getStoredCollections(libraryId))
      .filter((collection) =>
        itemIds.some((itemId) => collection.memberIds.has(itemId)),
      )
      .map((collection) => collection.title);
  }

  /**
   * The newest view of any member of a collection holding this item, so one
   * recently watched sibling keeps the whole set. Mirrors the Plex getter.
   */
  private async getCollectionSiblingsLastViewedAt(
    itemId: string,
    libraryId: string,
    ruleGroup?: RuleGroupDto,
  ): Promise<Date | null> {
    const collections = await this.getStoredCollections(libraryId);
    const included = new Set(
      filterRuleCollectionNames(
        collections.map((collection) => collection.title),
        ruleGroup,
      ),
    );

    let latest: Date | null = null;
    for (const collection of collections) {
      if (!included.has(collection.title)) continue;
      if (!collection.memberIds.has(itemId)) continue;

      for (const memberId of collection.memberIds) {
        const viewedAt = this.newestWatch(
          await this.siloAdapter.getWatchHistory(memberId),
        );
        if (viewedAt && (!latest || viewedAt > latest)) {
          latest = viewedAt;
        }
      }
    }

    return latest;
  }
}
