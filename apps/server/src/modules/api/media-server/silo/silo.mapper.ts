import {
  type MediaActor,
  type MediaCollection,
  type MediaGenre,
  type MediaItem,
  type MediaItemType,
  type MediaLibrary,
  type MediaProviderIds,
  type MediaRating,
  type MediaSource,
  type WatchRecord,
} from '@maintainerr/contracts';
import { addProviderId, emptyProviderIds } from '../media-provider-ids.utils';
import { SILO_LIBRARY_TYPES } from './silo.constants';
import type {
  SiloAdminCollection,
  SiloCastMember,
  SiloCatalogItem,
  SiloItemType,
  SiloLibrary,
  SiloPlaybackHistoryEntry,
  SiloSeason,
  SiloVersion,
} from './silo.types';

/**
 * Where an item sits, which Silo's own item shapes only partly carry: an
 * episode names its series and season number, not its season's content id,
 * and no item read names its library.
 */
export interface SiloItemContext {
  /** The episode's season content id */
  seasonId?: string;
  library?: { id: string; title: string };
}

export class SiloMapper {
  static toMediaItemType(type: SiloItemType | string): MediaItemType {
    switch (type) {
      case 'series':
        return 'show';
      case 'season':
        return 'season';
      case 'episode':
        return 'episode';
      default:
        return 'movie';
    }
  }

  /** The `type` scope a catalog listing takes for a Maintainerr item type. */
  static toCatalogType(type: MediaItemType): string {
    switch (type) {
      case 'show':
        return 'series';
      case 'episode':
        return 'episode';
      default:
        return 'movie';
    }
  }

  /** The Maintainerr library type of a Silo library, if it has one. */
  static toLibraryType(type: string): 'movie' | 'show' | undefined {
    return SILO_LIBRARY_TYPES.get((type ?? '').trim().toLowerCase());
  }

  static toMediaLibrary(library: SiloLibrary): MediaLibrary {
    return {
      id: library.id,
      title: library.name,
      type: SiloMapper.toLibraryType(library.type) ?? 'movie',
    };
  }

  /**
   * Maintain Plex-consistent parent semantics: a season's parent is its show,
   * an episode's parent is its season and its grandparent the show.
   */
  static toMediaItem(
    item: SiloCatalogItem,
    context: SiloItemContext = {},
  ): MediaItem {
    const type = SiloMapper.toMediaItemType(item.type);
    const parentId =
      type === 'season'
        ? item.series_id
        : type === 'episode'
          ? context.seasonId
          : undefined;
    const grandparentId = type === 'episode' ? item.series_id : undefined;
    const releaseDate =
      item.release_date ?? item.first_air_date ?? item.air_date;
    const durationMs = SiloMapper.toDurationMs(item);

    return {
      id: item.content_id,
      parentId,
      grandparentId,
      title: item.title,
      parentTitle:
        type === 'season' || type === 'episode' ? item.series_title : undefined,
      grandparentTitle: type === 'episode' ? item.series_title : undefined,
      guid: item.content_id,
      parentGuid: parentId,
      grandparentGuid: grandparentId,
      type,
      addedAt: new Date(item.added_at ?? ''),
      providerIds: SiloMapper.toProviderIds(item),
      mediaSources: SiloMapper.toMediaSources(item.versions),
      path: item.folder_paths?.[0] ?? item.versions?.[0]?.file_path,
      library: context.library ?? { id: '', title: '' },
      summary: item.overview || undefined,
      year: item.year || undefined,
      durationMs,
      originallyAvailableAt: releaseDate ? new Date(releaseDate) : undefined,
      contentRating: item.content_rating || undefined,
      ratings: SiloMapper.toMediaRatings(item),
      genres: SiloMapper.toMediaGenres(item.genres),
      actors: SiloMapper.toMediaActors(item.cast),
      childCount:
        type === 'show'
          ? item.season_count
          : type === 'season'
            ? item.episode_count
            : undefined,
      index:
        type === 'episode'
          ? item.episode_number
          : type === 'season'
            ? item.season_number
            : undefined,
      parentIndex: type === 'episode' ? item.season_number : undefined,
      studios: item.studios?.filter((studio) => studio.length > 0),
    };
  }

  /** A season row from the series' season list, in the item shape. */
  static toSeasonItem(
    season: SiloSeason,
    series: { id: string; title?: string },
    library?: { id: string; title: string },
  ): MediaItem {
    return SiloMapper.toMediaItem(
      {
        content_id: season.content_id,
        type: 'season',
        title: season.title,
        overview: season.overview,
        air_date: season.air_date,
        series_id: series.id,
        series_title: series.title,
        season_number: season.season_number,
        episode_count: season.episode_count,
      },
      { library },
    );
  }

  /**
   * One finished play. Silo records every attempt with its own completion
   * flag, so a profile that watched an item twice has two records - the same
   * shape as Plex's history, which viewCount counts.
   */
  static toWatchRecord(entry: SiloPlaybackHistoryEntry): WatchRecord {
    return {
      userId: entry.profile_id,
      itemId: entry.media_item_id,
      watchedAt: entry.ended_at ? new Date(entry.ended_at) : undefined,
      progress: entry.completed ? 100 : undefined,
    };
  }

  static toMediaCollection(collection: SiloAdminCollection): MediaCollection {
    return {
      id: collection.id,
      title: collection.title,
      summary: collection.description || undefined,
      childCount: collection.item_count,
      addedAt: collection.created_at
        ? new Date(collection.created_at)
        : undefined,
      updatedAt: collection.updated_at
        ? new Date(collection.updated_at)
        : undefined,
      // Only a smart collection is a live query. Imported types (trakt,
      // mdblist, tmdb) store their members like a manual one does.
      smart: collection.collection_type?.trim().toLowerCase() === 'smart',
      libraryId: collection.library_id || undefined,
    };
  }

  private static toProviderIds(item: SiloCatalogItem): MediaProviderIds {
    const providerIds = emptyProviderIds();
    addProviderId(providerIds, 'imdb', item.imdb_id);
    addProviderId(providerIds, 'tmdb', item.tmdb_id);
    addProviderId(providerIds, 'tvdb', item.tvdb_id);
    return providerIds;
  }

  private static toDurationMs(item: SiloCatalogItem): number | undefined {
    if (item.duration_seconds) {
      return Math.round(item.duration_seconds * 1000);
    }
    return item.runtime ? item.runtime * 60_000 : undefined;
  }

  private static toMediaSources(versions?: SiloVersion[]): MediaSource[] {
    if (!Array.isArray(versions)) {
      return [];
    }

    return versions.map((version) => ({
      id: version.file_id,
      duration: version.duration ? version.duration * 1000 : 0,
      bitrate: version.bitrate || undefined,
      audioCodec: version.codec_audio || undefined,
      videoCodec: version.codec_video || undefined,
      videoResolution: version.resolution || undefined,
      container: version.container || undefined,
      sizeBytes: version.file_size || undefined,
    }));
  }

  /**
   * One rating per source Silo reports, each on the 1-10 scale Maintainerr's
   * rating properties use. Silo keeps IMDb and TMDB on their own 10-point
   * scales and Rotten Tomatoes on 100.
   */
  private static toMediaRatings(item: SiloCatalogItem): MediaRating[] {
    const ratings: MediaRating[] = [];
    const add = (
      source: string,
      value: number | undefined,
      type: 'audience' | 'critic',
    ) => {
      if (value !== undefined && value !== null) {
        ratings.push({ source, value, type });
      }
    };

    add('imdb', item.rating_imdb, 'audience');
    add('tmdb', item.rating_tmdb, 'audience');
    add(
      'rottenTomatoes',
      SiloMapper.toTenPointScale(item.rating_rt_critic),
      'critic',
    );
    add(
      'rottenTomatoes',
      SiloMapper.toTenPointScale(item.rating_rt_audience),
      'audience',
    );
    return ratings;
  }

  private static toTenPointScale(score?: number): number | undefined {
    return score === undefined || score === null ? undefined : score / 10;
  }

  private static toMediaGenres(genres?: string[]): MediaGenre[] {
    if (!Array.isArray(genres)) {
      return [];
    }

    return genres.map((genre) => ({ name: genre }));
  }

  private static toMediaActors(cast?: SiloCastMember[]): MediaActor[] {
    if (!Array.isArray(cast)) {
      return [];
    }

    return cast.map((member) => ({
      name: member.name,
      role: member.character || undefined,
      thumb: member.photo_url || undefined,
    }));
  }
}
