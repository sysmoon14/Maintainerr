// Silo cache and batching tuning. TTLs are in SECONDS - node-cache takes ttl
// in seconds, not milliseconds (see api/lib/cache.ts and #3274).

export const SILO_CACHE_TTL = {
  METADATA: 300, // 5 min
  WATCH_HISTORY: 300, // 5 min
  USERS: 1800, // 30 min
  LIBRARIES: 1800, // 30 min
  STATUS: 60, // 1 min
  COLLECTIONS: 600, // 10 min
  // A season listing is assembled from every series in the library, so it is
  // kept for a rule run rather than rebuilt for each page the executor asks
  // for. cacheManager.flushAll() at the start of every run clears it.
  LIBRARY_SEASONS: 1800, // 30 min
} as const;

export const SILO_BATCH_SIZE = {
  // Silo has no multi-id item read, so a batch is this many parallel reads.
  METADATA: 8,
  COLLECTION_MUTATION: 8,
  SERIES_SEASONS: 5,
  // Every paginated Silo collection caps a page at 200.
  MAX_PAGE_SIZE: 200,
  DEFAULT_PAGE_SIZE: 50,
} as const;

export const SILO_CACHE_KEYS = {
  METADATA: 'silo:metadata',
  CHILDREN: 'silo:children',
  LISTED: 'silo:listed',
  SEASON_IDS: 'silo:season-ids',
  USERS: 'silo:users',
  LIBRARIES: 'silo:libraries',
  STATUS: 'silo:status',
  COLLECTIONS: 'silo:collections',
  WATCH_HISTORY: 'silo:watch-history',
  LIBRARY_SEASONS: 'silo:library-seasons',
} as const;

// One snapshot of the whole server's playback history; Silo answers it from a
// single endpoint, so it is not split per library like the Jellyfin sweep.
export const SILO_WATCH_SNAPSHOT_KEY = 'silo:watch-snapshot';

// The library kinds Maintainerr can manage, keyed by Silo's library type.
// Silo stores the type as free text ("movies", "TV", " Movies ") and matches
// it trimmed and lowercased against these spellings (internal/librarykind).
// Mixed, audiobook, ebook, podcast and manga libraries have no Maintainerr
// equivalent and are left out.
export const SILO_LIBRARY_TYPES = new Map<string, 'movie' | 'show'>([
  ['movie', 'movie'],
  ['movies', 'movie'],
  ['series', 'show'],
  ['tv', 'show'],
  ['show', 'show'],
  ['tvshows', 'show'],
]);

export const SILO_SERVER_NAME = 'Silo';
