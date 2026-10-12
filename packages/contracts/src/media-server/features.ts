import { MediaServerFeature, MediaServerType } from './enums'

/**
 * Feature support matrix for media servers.
 * Shared between server adapters and the UI so capability checks stay aligned.
 */
export const MEDIA_SERVER_FEATURES: Record<
  MediaServerType,
  ReadonlySet<MediaServerFeature>
> = {
  [MediaServerType.PLEX]: new Set([
    MediaServerFeature.COLLECTION_VISIBILITY,
    MediaServerFeature.WATCHLIST,
    MediaServerFeature.CENTRAL_WATCH_HISTORY,
    MediaServerFeature.LABELS,
    MediaServerFeature.PLAYLISTS,
    MediaServerFeature.COLLECTION_POSTER,
    MediaServerFeature.COLLECTION_SORT,
    // Verified against a live PMS 1.43.3: listings carry studio and sort=studio
    // genuinely sorts, though /library/sections/{id}/sorts never advertises it.
    MediaServerFeature.LIBRARY_STUDIO_SORT,
    MediaServerFeature.TRUSTWORTHY_EMPTY_COLLECTION,
  ]),
  [MediaServerType.JELLYFIN]: new Set([
    MediaServerFeature.LABELS, // Tags in Jellyfin
    MediaServerFeature.PLAYLISTS,
    MediaServerFeature.COLLECTION_POSTER,
    MediaServerFeature.CROSS_LIBRARY_COLLECTIONS, // BoxSets are server-global
    MediaServerFeature.LIBRARY_STUDIO_SORT,
    // Jellyfin has no central history endpoint, but /Items answers watch state
    // in bulk per user, which is all this flag gates (#3337).
    MediaServerFeature.CENTRAL_WATCH_HISTORY,
    // Note: COLLECTION_VISIBILITY not supported
    // Note: WATCHLIST not supported (no API)
    // Note: COLLECTION_SORT not supported - no boxset reorder API; ForcedSortName has global side-effects.
    // Note: TRUSTWORTHY_EMPTY_COLLECTION not supported - the BoxSet API can
    // answer with no children during a brief sync delay after a modification.
  ]),
  [MediaServerType.EMBY]: new Set([
    MediaServerFeature.LABELS,
    MediaServerFeature.PLAYLISTS,
    MediaServerFeature.COLLECTION_POSTER,
    MediaServerFeature.CROSS_LIBRARY_COLLECTIONS, // BoxSets are server-global
    // Verified on Emby 4.9.5: Fields=Studios returns data and SortBy=Studio
    // genuinely sorts (asc differs from the SortName baseline).
    MediaServerFeature.LIBRARY_STUDIO_SORT,
    // Conservative defaults mirroring Jellyfin:
    // - COLLECTION_VISIBILITY: Emby has no Plex-style home/recommended pinning.
    // - WATCHLIST: no public watchlist API.
    // - CENTRAL_WATCH_HISTORY: Emby omits LastPlayedDate and PlayCount from
    //   every bulk /Items listing shape and returns them only per item, so a
    //   bulk sweep would report watched items as having no watch date.
    // - COLLECTION_SORT: Emby exposes DisplayOrder = PremiereDate | SortName
    //   on a BoxSet but no item-move/reorder endpoint, so Maintainerr's
    //   "push an explicit ordered list of item IDs" contract isn't satisfiable.
    // - TRUSTWORTHY_EMPTY_COLLECTION: same .NET BoxSet sync delay as Jellyfin.
  ]),
  [MediaServerType.SILO]: new Set([
    // GET /api/v2/admin/playback-history pages every account's and profile's
    // finalized plays from one endpoint.
    MediaServerFeature.CENTRAL_WATCH_HISTORY,
    // Manual collection membership is read from the database inside the same
    // transaction that writes it, so an empty read is a real empty.
    MediaServerFeature.TRUSTWORTHY_EMPTY_COLLECTION,
    // Not supported (yet):
    // - COLLECTION_VISIBILITY: no Plex-style home/recommended pinning.
    // - WATCHLIST: per-profile only, no administrator read.
    // - LABELS: Silo has no item tags.
    // - PLAYLISTS: no playlist API.
    // - COLLECTION_POSTER / COLLECTION_SORT: Silo has both, left for a
    //   follow-up so the first version stays small.
    // - CROSS_LIBRARY_COLLECTIONS: Maintainerr creates each collection in the
    //   rule group's library, and Silo only accepts members from a
    //   collection's own libraries.
    // - LIBRARY_STUDIO_SORT: no studio sort on catalog listings.
  ]),
}

/**
 * Check whether a media server type supports a specific feature.
 */
export function supportsFeature(
  serverType: MediaServerType | null | undefined,
  feature: MediaServerFeature,
): boolean {
  return serverType ? MEDIA_SERVER_FEATURES[serverType].has(feature) : false
}
