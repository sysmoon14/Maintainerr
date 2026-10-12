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

    for (const prop of propsOf(Application.SILO)) {
      expect([prop.name, prop.id]).toEqual([
        prop.name,
        jellyfinIds.get(prop.name),
      ]);
    }
  });

  it('answers null for a property Silo cannot read', async () => {
    const favoritedBy = propsOf(Application.JELLYFIN).find(
      (prop) => prop.name === 'favoritedBy',
    )!.id;

    await expect(getter.get(favoritedBy, createItem())).resolves.toBeNull();
    expect(silo.getMetadata).not.toHaveBeenCalled();
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
});
