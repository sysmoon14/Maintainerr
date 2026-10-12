import { AxiosError } from 'axios';
import cacheManager from '../../lib/cache';
import { SiloAdapterService } from './silo-adapter.service';
import type { SiloCatalogItem, SiloPlaybackHistoryEntry } from './silo.types';

// testConnection builds its own client from the URL and key it is handed, so
// route every client the adapter builds to the fake below.
const probeClient: { http?: unknown } = {};
jest.mock('../../silo-api/silo-api.helper', () => ({
  SiloApi: jest.fn().mockImplementation(() => ({ axios: probeClient.http })),
}));

type Params = Record<string, unknown> | undefined;
type Handler = (params: Params, body?: unknown) => unknown;

/**
 * A stand-in Silo answering by method and path. A route that is not set up
 * answers 404, like Silo does for an unknown item.
 */
class FakeSilo {
  private readonly routes = new Map<string, Handler>();
  readonly calls: Array<{
    method: string;
    path: string;
    params: Params;
    body?: unknown;
    headers?: Record<string, string>;
  }> = [];

  on(method: string, path: string, handler: Handler | unknown): this {
    this.routes.set(
      `${method} ${path}`,
      typeof handler === 'function' ? (handler as Handler) : () => handler,
    );
    return this;
  }

  readonly http = {
    get: jest.fn((path: string, config?: { params?: Params }) =>
      this.answer('GET', path, config?.params),
    ),
    post: jest.fn((path: string, body?: unknown) =>
      this.answer('POST', path, undefined, body),
    ),
    put: jest.fn((path: string, body?: unknown) =>
      this.answer('PUT', path, undefined, body),
    ),
    patch: jest.fn(
      (
        path: string,
        body?: unknown,
        config?: { headers?: Record<string, string> },
      ) => this.answer('PATCH', path, undefined, body, config?.headers),
    ),
    delete: jest.fn(
      (path: string, config?: { headers?: Record<string, string> }) =>
        this.answer('DELETE', path, undefined, undefined, config?.headers),
    ),
  };

  private async answer(
    method: string,
    path: string,
    params: Params,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    this.calls.push({ method, path, params, body, headers });
    const handler = this.routes.get(`${method} ${path}`);
    if (!handler) throw responseError(404);
    return { data: await handler(params, body) };
  }

  callsTo(method: string, path: string) {
    return this.calls.filter(
      (call) => call.method === method && call.path === path,
    );
  }
}

const responseError = (status: number): AxiosError => {
  const error = new AxiosError(`request failed with status ${status}`);
  Object.assign(error, {
    response: { status, statusText: '', data: {}, headers: {}, config: {} },
  });
  return error;
};

const page = <T>(items: T[], nextCursor?: string) => ({
  items,
  page: { has_more: Boolean(nextCursor), next_cursor: nextCursor },
});

const catalogPage = (items: SiloCatalogItem[], total = items.length) => ({
  ...page(items),
  total,
  total_exact: true,
});

const play = (
  overrides: Partial<SiloPlaybackHistoryEntry>,
): SiloPlaybackHistoryEntry => ({
  session_id: `session-${Math.random()}`,
  user_id: '1',
  profile_id: 'profile-a',
  profile_name: 'A',
  media_item_id: 'movie-tmdb-1',
  media_type: 'movie',
  started_at: '2026-01-01T20:00:00.000Z',
  ended_at: '2026-01-01T22:00:00.000Z',
  completed: true,
  ...overrides,
});

const movie: SiloCatalogItem = {
  content_id: 'movie-tmdb-1',
  type: 'movie',
  title: 'Sample Movie',
  added_at: '2025-06-01T00:00:00.000Z',
  tmdb_id: '1',
};

const series: SiloCatalogItem = {
  content_id: 'series-tvdb-9',
  type: 'series',
  title: 'Sample Series',
  added_at: '2025-06-01T00:00:00.000Z',
};

const episode = (season: number, number: number): SiloCatalogItem => ({
  content_id: `episode-tvdb-9-${season}-${number}`,
  type: 'episode',
  title: `Episode ${number}`,
  series_id: series.content_id,
  series_title: series.title,
  season_number: season,
  episode_number: number,
});

describe('SiloAdapterService', () => {
  let service: SiloAdapterService;
  let silo: FakeSilo;

  /** A series with one season of two episodes. */
  const withSeries = () =>
    silo
      .on('GET', `/catalog/items/${series.content_id}`, series)
      .on(
        'GET',
        `/catalog/series/${series.content_id}/seasons`,
        page([
          {
            content_id: 'season-tvdb-9-1',
            season_number: 1,
            title: 'Season 1',
            episode_count: 2,
          },
        ]),
      )
      .on(
        'GET',
        '/catalog/items/season-tvdb-9-1/episodes',
        page([episode(1, 1), episode(1, 2)]),
      );

  beforeEach(() => {
    cacheManager.getCache('silo').flush();
    cacheManager.getCache('silowatchhistory').flush();

    silo = new FakeSilo();
    service = new SiloAdapterService(
      { silo_url: 'http://silo.test:8080', silo_api_key: 'sa_key' } as any,
      {
        setContext: jest.fn(),
        debug: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as any,
    );
    Object.assign(service, { http: silo.http, initialized: true });
    probeClient.http = silo.http;
  });

  describe('testConnection', () => {
    it('refuses a key that does not belong to an administrator', async () => {
      silo
        .on('GET', '/system/info', { api_major: 2, server_version: 'abc' })
        .on('GET', '/account/me', { id: '2', username: 'kid', role: 'user' });

      const result = await service.testConnection(
        'http://silo.test:8080',
        'sa_key',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('administrator');
    });
  });

  describe('getUsers', () => {
    it('lists every profile of every enabled account, qualifying shared names', async () => {
      silo
        .on('GET', '/admin/users', (params) =>
          params?.cursor
            ? page([{ id: '2', username: 'bob', enabled: true, role: 'user' }])
            : page(
                [
                  { id: '1', username: 'ann', enabled: true, role: 'admin' },
                  { id: '3', username: 'old', enabled: false, role: 'user' },
                ],
                'next',
              ),
        )
        .on(
          'GET',
          '/admin/users/1/profiles',
          page([
            { id: 'p1', name: 'Ann' },
            { id: 'p2', name: 'Kids' },
          ]),
        )
        .on(
          'GET',
          '/admin/users/2/profiles',
          page([{ id: 'p3', name: 'Kids' }]),
        );

      await expect(service.getUsers()).resolves.toEqual([
        { id: 'p1', name: 'Ann' },
        { id: 'p2', name: 'Kids (ann)' },
        { id: 'p3', name: 'Kids (bob)' },
      ]);
      expect(silo.callsTo('GET', '/admin/users/3/profiles')).toHaveLength(0);
    });

    it('refuses a page that claims more items without a cursor', async () => {
      silo.on('GET', '/admin/users', {
        items: [],
        page: { has_more: true },
      });

      await expect(service.getUsers(true)).rejects.toThrow('without a cursor');
    });
  });

  describe('getLibraries', () => {
    it('keeps only enabled movie and series libraries', async () => {
      silo.on(
        'GET',
        '/libraries',
        page([
          { id: '1', name: 'Movies', type: 'movies', enabled: true },
          { id: '2', name: 'Shows', type: 'series', enabled: true },
          // Silo keeps the type as free text and matches it loosely.
          { id: '5', name: 'Films', type: ' Movie ', enabled: true },
          { id: '6', name: 'TV', type: 'TV', enabled: true },
          { id: '3', name: 'Books', type: 'ebooks', enabled: true },
          { id: '7', name: 'Everything', type: 'mixed', enabled: true },
          { id: '4', name: 'Old', type: 'movies', enabled: false },
        ]),
      );

      await expect(service.getLibraries()).resolves.toEqual([
        { id: '1', title: 'Movies', type: 'movie' },
        { id: '2', title: 'Shows', type: 'show' },
        { id: '5', title: 'Films', type: 'movie' },
        { id: '6', title: 'TV', type: 'show' },
      ]);
    });
  });

  describe('getLibraryContents', () => {
    beforeEach(() => {
      silo.on(
        'GET',
        '/libraries',
        page([
          { id: '1', name: 'Movies', type: 'movies', enabled: true },
          { id: '2', name: 'Shows', type: 'series', enabled: true },
        ]),
      );
    });

    it('pages by offset and tags each item with its library', async () => {
      silo.on('GET', '/catalog', catalogPage([movie], 120));

      const result = await service.getLibraryContents('1', {
        offset: 50,
        limit: 50,
      });

      expect(silo.callsTo('GET', '/catalog')[0].params).toMatchObject({
        library_id: '1',
        type: 'movie',
        seek: 50,
        limit: 50,
      });
      expect(result.totalSize).toBe(120);
      expect(result.items[0]).toMatchObject({
        id: movie.content_id,
        type: 'movie',
        library: { id: '1', title: 'Movies' },
        providerIds: { tmdb: ['1'] },
      });
    });

    it('resolves each episode to its season with one read per series', async () => {
      withSeries().on(
        'GET',
        '/catalog',
        catalogPage([episode(1, 1), episode(1, 2)]),
      );

      const { items } = await service.getLibraryContents('2', {
        type: 'episode',
      });

      expect(items.map((item) => [item.parentId, item.grandparentId])).toEqual([
        ['season-tvdb-9-1', series.content_id],
        ['season-tvdb-9-1', series.content_id],
      ]);
      expect(
        silo.callsTo('GET', `/catalog/series/${series.content_id}/seasons`),
      ).toHaveLength(1);
    });

    it('assembles seasons from the library shows, since the catalog has no season scope', async () => {
      withSeries().on('GET', '/catalog', page([series]));

      const result = await service.getLibraryContents('2', {
        type: 'season',
        offset: 0,
        limit: 50,
      });

      expect(result.totalSize).toBe(1);
      expect(result.items[0]).toMatchObject({
        id: 'season-tvdb-9-1',
        type: 'season',
        parentId: series.content_id,
      });
    });

    it('re-throws a failed page instead of answering an empty library', async () => {
      silo.on('GET', '/catalog', () => {
        throw responseError(502);
      });

      await expect(service.getLibraryContents('1')).rejects.toThrow();
      await expect(service.getLibraryContentCount('1')).rejects.toThrow();
    });
  });

  describe('itemExists', () => {
    it('reads a 404 as gone and anything else as unknown', async () => {
      silo.on('GET', '/catalog/items/movie-tmdb-2', () => {
        throw responseError(500);
      });

      await expect(service.itemExists('movie-tmdb-404')).resolves.toBe(false);
      await expect(service.itemExists('movie-tmdb-2')).rejects.toThrow();
    });
  });

  describe('watch history', () => {
    it('answers completed plays per profile from the prefetched snapshot', async () => {
      silo
        .on('GET', `/catalog/items/${movie.content_id}`, movie)
        .on(
          'GET',
          '/admin/playback-history',
          page([
            play({ profile_id: 'p1' }),
            play({ profile_id: 'p1', ended_at: '2026-02-01T00:00:00.000Z' }),
            play({ profile_id: 'p2', completed: false }),
          ]),
        );

      await service.prefetchWatchHistory({ libraryId: '1' });
      const history = await service.getWatchHistory(movie.content_id);

      expect(history.map((record) => record.userId)).toEqual(['p1', 'p1']);
      await expect(service.getItemSeenBy(movie.content_id)).resolves.toEqual([
        'p1',
      ]);
      // Prefetched once, then served from memory.
      expect(silo.callsTo('GET', '/admin/playback-history')).toHaveLength(1);
    });

    it("answers a show's history from its episodes", async () => {
      withSeries().on('GET', '/admin/playback-history', (params) =>
        page(
          params?.media_item_id === 'episode-tvdb-9-1-2'
            ? [play({ media_item_id: 'episode-tvdb-9-1-2', profile_id: 'p2' })]
            : [],
        ),
      );

      const history = await service.getWatchHistory(series.content_id);

      expect(history).toEqual([
        expect.objectContaining({
          userId: 'p2',
          itemId: 'episode-tvdb-9-1-2',
        }),
      ]);
    });

    it('reads watch state live, never from the snapshot', async () => {
      silo
        .on('GET', `/catalog/items/${movie.content_id}`, movie)
        .on('GET', '/admin/playback-history', (params) =>
          // The snapshot read is unfiltered; the live read asks for the item.
          params?.media_item_id ? page([play({})]) : page([]),
        );

      await service.prefetchWatchHistory({ libraryId: '1' });

      await expect(service.getWatchState(movie.content_id)).resolves.toEqual({
        viewCount: 1,
        isWatched: true,
      });
      expect(
        silo
          .callsTo('GET', '/admin/playback-history')
          .find((call) => call.params?.media_item_id)?.params,
      ).toMatchObject({ media_item_id: movie.content_id, completed: 'true' });
    });

    it('falls back to live reads when the prefetch fails', async () => {
      let failSnapshot = true;
      silo
        .on('GET', `/catalog/items/${movie.content_id}`, movie)
        .on('GET', '/admin/playback-history', (params) => {
          if (!params?.media_item_id && failSnapshot) {
            failSnapshot = false;
            throw responseError(502);
          }
          return page([play({})]);
        });

      await service.prefetchWatchHistory({ libraryId: '1' });

      await expect(
        service.getWatchHistory(movie.content_id),
      ).resolves.toHaveLength(1);
    });

    it('propagates a failed read instead of answering "never watched"', async () => {
      silo
        .on('GET', `/catalog/items/${movie.content_id}`, movie)
        .on('GET', '/admin/playback-history', () => {
          throw responseError(502);
        });

      await expect(service.getWatchHistory(movie.content_id)).rejects.toThrow();
    });

    it('counts unfinished plays toward the last played date', async () => {
      silo
        .on('GET', `/catalog/items/${movie.content_id}`, movie)
        .on(
          'GET',
          '/admin/playback-history',
          page([
            play({ completed: false, ended_at: '2026-03-01T00:00:00.000Z' }),
            play({ ended_at: '2026-01-01T00:00:00.000Z' }),
          ]),
        );

      await service.prefetchWatchHistory({ libraryId: '1' });

      await expect(service.getLastPlayedAt(movie.content_id)).resolves.toEqual(
        new Date('2026-03-01T00:00:00.000Z'),
      );
    });
  });

  describe('getActiveSessions', () => {
    it('protects a playing episode with its season and show', async () => {
      withSeries()
        .on(
          'GET',
          '/admin/sessions',
          page([{ content_id: 'episode-tvdb-9-1-1' }]),
        )
        .on('GET', '/catalog/items/episode-tvdb-9-1-1', episode(1, 1));

      await expect(service.getActiveSessions()).resolves.toEqual(
        new Set(['episode-tvdb-9-1-1', 'season-tvdb-9-1', series.content_id]),
      );
    });
  });

  describe('collections', () => {
    const collection = {
      id: 'c1',
      title: 'Leaving Soon',
      description: '',
      library_id: '1',
      library_ids: ['1'],
      item_count: 0,
      collection_type: 'manual',
      management_mode: 'manual',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };

    it('reads a 404 as a deleted collection and any other failure as unknown', async () => {
      silo.on('GET', '/admin/collections/c2', () => {
        throw responseError(503);
      });

      await expect(service.getCollection('c1', true)).resolves.toBeUndefined();
      await expect(service.getCollection('c2', true)).rejects.toThrow();
    });

    it.each(['season', 'episode'] as const)(
      'refuses a %s collection before creating anything',
      async (type) => {
        await expect(
          service.createCollection({ libraryId: '1', title: 'T', type }),
        ).rejects.toThrow('only hold movies and shows');
        expect(silo.callsTo('POST', '/admin/collections')).toHaveLength(0);
      },
    );

    it('creates in the rule group library and adds the initial item', async () => {
      silo
        .on('POST', '/admin/collections', collection)
        .on('PUT', `/admin/collections/c1/items/${movie.content_id}`, {});

      const created = await service.createCollection({
        libraryId: '1',
        title: 'Leaving Soon',
        type: 'movie',
        initialItemId: movie.content_id,
      });

      expect(silo.callsTo('POST', '/admin/collections')[0].body).toEqual({
        title: 'Leaving Soon',
        description: '',
        library_id: '1',
      });
      expect(created).toMatchObject({ id: 'c1', childCount: 1, smart: false });
    });

    it.each([
      ['DELETE', () => service.deleteCollection('c1')],
      [
        'PATCH',
        () =>
          service.updateCollection({
            libraryId: '1',
            collectionId: 'c1',
            title: 'New',
          }),
      ],
    ])('sends %s without a stale validator', async (method, run) => {
      silo.on(method, '/admin/collections/c1', collection);

      await run();

      expect(silo.callsTo(method, '/admin/collections/c1')[0].headers).toEqual({
        'If-Match': '*',
      });
    });

    it('reports refused and unanswered members apart', async () => {
      silo
        .on('PUT', '/admin/collections/c1/items/ok', {})
        .on('PUT', '/admin/collections/c1/items/foreign', () => {
          throw responseError(404);
        })
        .on('PUT', '/admin/collections/c1/items/timeout', () => {
          throw new AxiosError('timeout');
        });

      await expect(
        service.addBatchToCollection('c1', ['ok', 'foreign', 'timeout']),
      ).resolves.toEqual({ refused: ['foreign'], unknown: ['timeout'] });
    });

    it('keeps a member whose metadata cannot be read', async () => {
      silo
        .on('GET', '/admin/collections/c1', collection)
        .on(
          'GET',
          '/admin/collections/c1/items',
          page([
            {
              collection_id: 'c1',
              media_item_id: movie.content_id,
              position: 0,
            },
            {
              collection_id: 'c1',
              media_item_id: 'series-tvdb-404',
              position: 1,
              title: 'Gone',
            },
          ]),
        )
        .on('GET', `/catalog/items/${movie.content_id}`, movie);

      const children = await service.getCollectionChildren('c1');

      expect(children.map((child) => [child.id, child.type])).toEqual([
        [movie.content_id, 'movie'],
        ['series-tvdb-404', 'show'],
      ]);
    });

    it('re-throws a failed membership read instead of answering empty', async () => {
      silo
        .on('GET', '/admin/collections/c1', collection)
        .on('GET', '/admin/collections/c1/items', () => {
          throw responseError(502);
        });

      await expect(service.getCollectionChildren('c1')).rejects.toThrow();
    });

    it('refuses to list a smart collection, whose manual membership is always empty', async () => {
      silo
        .on('GET', '/admin/collections/c1', {
          ...collection,
          collection_type: 'query',
        })
        .on('GET', '/admin/collections/c1/items', page([]));

      await expect(service.getCollectionChildren('c1')).rejects.toThrow(
        'smart collection',
      );
    });

    it('leaves a collection based in another library untouched on cleanup', async () => {
      silo.on('GET', '/admin/collections/c1', {
        ...collection,
        library_id: '7',
      });

      await expect(
        service.cleanupCollectionForLibrary('c1', '1', false),
      ).rejects.toThrow('library membership');
      expect(silo.calls.filter((call) => call.method !== 'GET')).toHaveLength(
        0,
      );
    });
  });

  it('never deletes from disk', async () => {
    await expect(service.deleteFromDisk(movie.content_id)).rejects.toThrow(
      'Radarr or Sonarr',
    );
    expect(silo.calls).toHaveLength(0);
  });
});
