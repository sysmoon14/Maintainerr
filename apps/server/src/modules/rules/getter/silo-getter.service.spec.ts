import { MediaItem, MediaUser, WatchRecord } from '@maintainerr/contracts';
import { Mocked, TestBed } from '@suites/unit';
import { createRuleGroupDto } from '../../../../test/utils/data';
import cacheManager from '../../api/lib/cache';
import { SiloAdapterService } from '../../api/media-server/silo/silo-adapter.service';
import { Application, RuleConstants } from '../constants/rules.constants';
import { SiloGetterService } from './silo-getter.service';

const propsOf = (application: Application) =>
  new RuleConstants().applications.find((app) => app.id === application)!.props;

const propId = (name: string) =>
  propsOf(Application.SILO).find((prop) => prop.name === name)!.id;

const createItem = (overrides: Partial<MediaItem> = {}): MediaItem => ({
  id: 'movie-tmdb-1',
  title: 'Sample Movie',
  type: 'movie',
  guid: 'movie-tmdb-1',
  addedAt: new Date('2024-01-15'),
  providerIds: { tmdb: ['1'] },
  mediaSources: [],
  library: { id: '1', title: 'Movies' },
  ...overrides,
});

const users: MediaUser[] = [
  { id: 'p1', name: 'Ann' },
  { id: 'p2', name: 'Kids (ann)' },
];

const watched = (userId: string, itemId: string, at: string): WatchRecord => ({
  userId,
  itemId,
  watchedAt: new Date(at),
});

describe('SiloGetterService', () => {
  let getter: SiloGetterService;
  let silo: Mocked<SiloAdapterService>;

  beforeEach(async () => {
    const { unit, unitRef } =
      await TestBed.solitary(SiloGetterService).compile();
    getter = unit;
    silo = unitRef.get(SiloAdapterService);
    silo.isSetup.mockReturnValue(true);
    silo.getUsers.mockResolvedValue(users);
  });

  afterEach(() => {
    cacheManager.getCache('silo').flush();
  });

  it('keeps the Jellyfin id of every property it shares, so rules move between servers unchanged', () => {
    const jellyfinIds = new Map(
      propsOf(Application.JELLYFIN).map((prop) => [prop.name, prop.id]),
    );

    const shared = propsOf(Application.SILO).filter((prop) =>
      jellyfinIds.has(prop.name),
    );
    expect(shared.length).toBeGreaterThan(40);
    for (const prop of shared) {
      expect([prop.name, prop.id]).toEqual([
        prop.name,
        jellyfinIds.get(prop.name),
      ]);
    }
  });

  it('gives its own properties ids no Jellyfin property uses', () => {
    const jellyfinIds = new Set(
      propsOf(Application.JELLYFIN).map((prop) => prop.id),
    );
    const own = propsOf(Application.SILO).filter(
      (prop) =>
        !propsOf(Application.JELLYFIN).some(
          (other) => other.name === prop.name,
        ),
    );

    expect(own.map((prop) => prop.name)).toEqual([
      'isInWatchlist',
      'watchlistedByUsers',
      'isInWatchlist_including_parent',
      'watchlistedByUsers_including_parent',
    ]);
    expect(own.filter((prop) => jellyfinIds.has(prop.id))).toEqual([]);
  });

  it('answers null for a property Silo cannot read', async () => {
    const playlists = propsOf(Application.JELLYFIN).find(
      (prop) => prop.name === 'playlists',
    )!.id;

    await expect(getter.get(playlists, createItem())).resolves.toBeNull();
    expect(silo.getMetadata).not.toHaveBeenCalled();
  });

  it('names the profiles that favourited an item or its show', async () => {
    const episode = createItem({
      id: 'e1',
      type: 'episode',
      parentId: 's1',
      grandparentId: 'show-1',
    });
    silo.getMetadata.mockResolvedValue(episode);
    silo.getItemFavoritedBy.mockImplementation(async (ids) =>
      ids.includes('show-1') ? ['p2'] : [],
    );

    await expect(
      getter.get(propId('sw_favoritedBy'), episode, 'episode'),
    ).resolves.toEqual([]);
    await expect(
      getter.get(propId('sw_favoritedBy_including_parent'), episode, 'episode'),
    ).resolves.toEqual(['Kids (ann)']);
    expect(silo.getItemFavoritedBy).toHaveBeenLastCalledWith([
      'e1',
      's1',
      'show-1',
    ]);
  });

  it('answers the watchlist properties from the profiles holding the item', async () => {
    silo.getMetadata.mockResolvedValue(createItem());
    silo.getItemWatchlistedBy.mockResolvedValue(['p1']);

    await expect(
      getter.get(propId('isInWatchlist'), createItem()),
    ).resolves.toBe(true);
    await expect(
      getter.get(propId('watchlistedByUsers'), createItem()),
    ).resolves.toEqual(['Ann']);

    silo.getItemWatchlistedBy.mockResolvedValue([]);
    await expect(
      getter.get(propId('isInWatchlist'), createItem()),
    ).resolves.toBe(false);
  });

  it('keeps a failed watchlist read transient', async () => {
    silo.getMetadata.mockResolvedValue(createItem());
    silo.getItemWatchlistedBy.mockRejectedValue(new Error('502'));

    await expect(
      getter.get(propId('isInWatchlist'), createItem()),
    ).resolves.toBeUndefined();
  });

  it('keeps a failed metadata read transient', async () => {
    silo.getMetadata.mockResolvedValue(undefined);

    await expect(
      getter.get(propId('seenBy'), createItem()),
    ).resolves.toBeUndefined();
  });

  it('names the profiles that finished an item', async () => {
    silo.getMetadata.mockResolvedValue(createItem());
    silo.getItemSeenBy.mockResolvedValue(['p2']);

    await expect(getter.get(propId('seenBy'), createItem())).resolves.toEqual([
      'Kids (ann)',
    ]);
  });

  it('counts only profiles that finished every episode for sw_allEpisodesSeenBy', async () => {
    const season = createItem({ id: 'season-1', type: 'season' });
    silo.getMetadata.mockResolvedValue(season);
    silo.getDescendantEpisodeWatchHistory.mockResolvedValue({
      e1: [
        watched('p1', 'e1', '2024-02-01'),
        watched('p2', 'e1', '2024-02-01'),
      ],
      e2: [watched('p1', 'e2', '2024-02-02')],
    });

    await expect(
      getter.get(propId('sw_allEpisodesSeenBy'), season, 'season'),
    ).resolves.toEqual(['Ann']);
  });

  it.each([
    ['rating_imdb', 7.1],
    ['rating_tmdb', 6.5],
    ['rating_rottenTomatoesCritic', 9.2],
    ['rating_rottenTomatoesAudience', 8.4],
    ['rating_critics', 9.2],
    ['rating_audience', 6.5],
  ])('reads %s from its own source', async (name, expected) => {
    silo.getMetadata.mockResolvedValue(
      createItem({
        ratings: [
          { source: 'imdb', value: 7.1, type: 'audience' },
          { source: 'tmdb', value: 6.5, type: 'audience' },
          { source: 'rottenTomatoes', value: 9.2, type: 'critic' },
          { source: 'rottenTomatoes', value: 8.4, type: 'audience' },
        ],
      }),
    );

    await expect(getter.get(propId(name), createItem())).resolves.toBe(
      expected,
    );
  });

  it('dates sw_lastWatched by the highest watched episode, not the newest view', async () => {
    const show = createItem({ id: 'series-1', type: 'show' });
    silo.getMetadata.mockResolvedValue(show);
    silo.getChildrenMetadata.mockResolvedValue([
      createItem({ id: 'e1', type: 'episode', parentIndex: 1, index: 1 }),
      createItem({ id: 'e2', type: 'episode', parentIndex: 2, index: 1 }),
    ]);
    silo.getDescendantEpisodeWatchHistory.mockResolvedValue({
      // Rewatched the first episode after finishing season 2.
      e1: [watched('p1', 'e1', '2024-05-01')],
      e2: [watched('p1', 'e2', '2024-03-01')],
    });

    await expect(
      getter.get(propId('sw_lastWatched'), show, 'show'),
    ).resolves.toEqual(new Date('2024-03-01'));
  });

  it('counts the manual collections holding the item, skipping smart ones it cannot list', async () => {
    silo.getMetadata.mockResolvedValue(createItem());
    silo.getCollections.mockResolvedValue([
      { id: 'c1', title: 'Leaving Soon ', childCount: 1 },
      { id: 'c2', title: 'Other', childCount: 1 },
      { id: 'c3', title: 'Recently Added', childCount: 9, smart: true },
    ]);
    silo.getCollectionMemberIds.mockImplementation(async (id) => {
      if (id === 'c3') throw new Error('smart collection');
      return id === 'c1' ? ['movie-tmdb-1'] : ['movie-tmdb-2'];
    });
    const ruleGroup = createRuleGroupDto({ libraryId: '1' });

    await expect(
      getter.get(propId('collection_names'), createItem(), 'movie', ruleGroup),
    ).resolves.toEqual(['Leaving Soon']);
    await expect(
      getter.get(propId('collections'), createItem(), 'movie', ruleGroup),
    ).resolves.toBe(1);
  });

  it('reads each collection once for items evaluated together', async () => {
    silo.getMetadata.mockImplementation(async (id) =>
      createItem({ id: String(id) }),
    );
    silo.getCollections.mockResolvedValue([
      { id: 'c1', title: 'James Bond', childCount: 2 },
      { id: 'c2', title: 'Other', childCount: 0 },
    ]);
    silo.getCollectionMemberIds.mockImplementation(async (id) =>
      id === 'c1' ? ['movie-tmdb-1', 'movie-tmdb-2'] : [],
    );
    const ruleGroup = createRuleGroupDto({ libraryId: '1' });

    const counts = await Promise.all(
      ['movie-tmdb-1', 'movie-tmdb-2', 'movie-tmdb-3'].map((id) =>
        getter.get(
          propId('collections'),
          createItem({ id }),
          'movie',
          ruleGroup,
        ),
      ),
    );

    expect(counts).toEqual([1, 1, 0]);
    expect(silo.getCollections).toHaveBeenCalledTimes(1);
    expect(silo.getCollectionMemberIds).toHaveBeenCalledTimes(2);
  });
});
