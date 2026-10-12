import { SiloRequestPacer } from './silo-request-pacer';

describe('SiloRequestPacer', () => {
  // A fake clock: sleeping advances it, so the test measures what the pacer
  // would have waited without waiting.
  const fakeClock = () => {
    let nowMs = 0;
    return {
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
      elapsed: () => nowMs,
    };
  };

  const sendAll = async (pacer: SiloRequestPacer, count: number) => {
    await Promise.all(Array.from({ length: count }, () => pacer.acquire()));
  };

  it('lets a burst up to the paced rate through, then spaces the rest', async () => {
    const clock = fakeClock();
    const pacer = new SiloRequestPacer(20, clock.now, clock.sleep);

    // 18 a second under Silo's default 20: the first 18 go at once and the
    // next 18 take a second more.
    await sendAll(pacer, 18);
    expect(clock.elapsed()).toBe(0);

    await sendAll(pacer, 18);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(990);
    expect(clock.elapsed()).toBeLessThanOrEqual(1020);
  });

  it('never sends faster than the limit over a long run', async () => {
    const clock = fakeClock();
    const pacer = new SiloRequestPacer(20, clock.now, clock.sleep);

    await sendAll(pacer, 1000);

    // Requests per second actually sent, the opening burst included.
    expect(1000 / (clock.elapsed() / 1000)).toBeLessThanOrEqual(20);
  });

  it('adopts the limit a response declares', async () => {
    const clock = fakeClock();
    const pacer = new SiloRequestPacer(20, clock.now, clock.sleep);

    pacer.observeLimit('100');
    expect(pacer.requestsPerSecond).toBe(90);
    pacer.observeLimit(undefined);
    pacer.observeLimit('nonsense');
    expect(pacer.requestsPerSecond).toBe(90);
  });
});
