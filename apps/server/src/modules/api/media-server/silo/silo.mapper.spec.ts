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
