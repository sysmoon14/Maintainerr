import { emptyProviderIds } from '../media-provider-ids.utils';
import { SiloMapper } from './silo.mapper';

describe('SiloMapper', () => {
  it('puts every rating on the 10-point scale rules compare against', () => {
    const item = SiloMapper.toMediaItem({
      content_id: 'movie-tmdb-1',
      type: 'movie',
      title: 'Sample Movie',
      rating_imdb: 7.1,
      rating_tmdb: 6.5,
      rating_rt_critic: 92,
      rating_rt_audience: 84,
    });

    expect(item.ratings).toEqual([
      { source: 'imdb', value: 7.1, type: 'audience' },
      { source: 'tmdb', value: 6.5, type: 'audience' },
      { source: 'rottenTomatoes', value: 9.2, type: 'critic' },
      { source: 'rottenTomatoes', value: 8.4, type: 'audience' },
    ]);
  });

  // Catalog listings carry no provider ids, and the UI finds a poster by
  // them, so without these a library showed no posters. An episode's id
  // names its series, which must not read as the episode's own TVDB id.
  it.each([
    ['movie-tmdb-228064', 'movie', { tmdb: ['228064'] }],
    ['movie-imdb-tt0944947', 'movie', { imdb: ['tt0944947'] }],
    ['series-tvdb-296762', 'series', { tvdb: ['296762'] }],
    ['episode-tvdb-296762-1-5', 'episode', {}],
    ['local-0123abcd', 'movie', {}],
  ] as const)(
    'reads the provider id of a listed %s from its content id',
    (contentId, type, expected) => {
      const { providerIds } = SiloMapper.toMediaItem({
        content_id: contentId,
        type,
        title: 'Sample',
      });

      expect(providerIds).toEqual({
        ...emptyProviderIds(),
        ...expected,
      });
    },
  );

  it.each([
    ['season', { parentId: 'series-tvdb-9', grandparentId: undefined }],
    [
      'episode',
      { parentId: 'season-tvdb-9-2', grandparentId: 'series-tvdb-9' },
    ],
  ] as const)('gives a %s Plex-style parents', (type, parents) => {
    const item = SiloMapper.toMediaItem(
      {
        content_id: `${type}-tvdb-9-2`,
        type,
        title: 'Sample',
        series_id: 'series-tvdb-9',
        season_number: 2,
      },
      { seasonId: 'season-tvdb-9-2' },
    );

    expect({
      parentId: item.parentId,
      grandparentId: item.grandparentId,
    }).toEqual(parents);
  });
});
