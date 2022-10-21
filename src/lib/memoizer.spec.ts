import { createClient } from 'redis';
import { createMemoizer, produceKeyWithArgs } from './memoizer';

const flushRedis = async () => {
  const client = createClient();
  await client.connect();
  await client.flushDb();
  await client.disconnect();
};

const sleep = (n: number) =>
  new Promise((resolve) => setTimeout(resolve, n * 1000));

describe('produceKeyWithArgs', () => {
  test('produceKeyWithArgs should produce the same key for differently ordered objects', () => {
    expect(produceKeyWithArgs('prefix', 'key', { a: 1, b: 2 })).toEqual(
      produceKeyWithArgs('prefix', 'key', { b: 2, a: 1 })
    );
  });

  test('should use sha1 for nested object values', () => {
    const keyHash = produceKeyWithArgs('prefix', 'key', { a: { b: 1 } });
    expect(keyHash).toMatch(/|prefix|key|a:.*/);
  });
});

describe('basic functionality', () => {
  afterAll(async () => {
    await flushRedis();
  });

  test('should only call function once for same args', async () => {
    const memoizer = await createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'basic',
    });

    const args = { a: 4 };
    await memoizedFunction(args);
    await memoizedFunction(args);
    await memoizer.quit();

    expect(mock).toHaveBeenCalledTimes(1);
  });

  test('should distinguish different args', async () => {
    const memoizer = await createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'different',
    });

    await memoizedFunction({ a: 1 });
    await memoizedFunction({ a: 2 });
    await memoizer.quit();

    expect(mock).toHaveBeenCalledTimes(2);
  });

  test('should lock duplicate calls', async () => {
    const memoizer = await createMemoizer({});

    const mock = jest.fn();

    const memoizableSlowFunction = async () => {
      await sleep(1);
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableSlowFunction, {
      key: 'locking',
    });

    await Promise.all([memoizedFunction({ a: 1 }), memoizedFunction({ a: 1 })]);
    await memoizer.quit();

    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('invalidation', () => {
  afterAll(async () => {
    await flushRedis();
  });

  test('should call twice if invalidated', async () => {
    const memoizer = await createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'basic-invalidate',
    });

    const args = { a: 4 };
    await memoizedFunction(args);
    await memoizer.invalidate('basic-invalidate', args);
    await memoizedFunction(args);
    expect(mock).toHaveBeenCalledTimes(2);

    await memoizer.quit();
  });

  test('should call once if different arg is invalidated', async () => {
    const memoizer = await createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'missed-invalidate',
    });

    await memoizedFunction({ a: 4 });
    await memoizer.invalidate('basic-invalidate', { a: 5 });
    await memoizedFunction({ a: 4 });
    expect(mock).toHaveBeenCalledTimes(1);

    await memoizer.quit();
  });

  test('should call twice if different compound covered invalidate', async () => {
    const memoizer = await createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'compound-covered-invalidate',
    });

    await memoizedFunction({ a: 1, b: 2 });
    await memoizer.invalidate('compound-covered-invalidate', { a: 1 });
    await memoizedFunction({ a: 1, b: 2 });
    expect(mock).toHaveBeenCalledTimes(2);

    await memoizer.quit();
  });

  test('should call once if invalidation is partially wrong', async () => {
    const memoizer = await createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'compound-missed-invalidate',
    });

    await memoizedFunction({ a: 1, b: 2 });
    await memoizer.invalidate('compound-missed-invalidate', { a: 1, b: 3 });
    await memoizedFunction({ a: 1, b: 2 });
    expect(mock).toHaveBeenCalledTimes(1);

    await memoizer.quit();
  });
});

describe('prefixes', () => {
  afterAll(async () => {
    await flushRedis();
  });

  test('should keep keyspaces separate', async () => {
    const a = await createMemoizer({ prefix: 'a' });
    const b = await createMemoizer({ prefix: 'b' });

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const aF = a.memoize(memoizableFunction, {
      key: 'prefix-test',
    });

    const bF = b.memoize(memoizableFunction, {
      key: 'prefix-test',
    });

    await aF({ a: 1 });
    await bF({ a: 1 });

    expect(mock).toHaveBeenCalledTimes(2);

    await a.quit();
    await b.quit();
  });
});

describe('empty mode', () => {
  afterAll(async () => {
    await flushRedis();
  });

  test('if empty mode should not cache', async () => {
    const memoizer = await createMemoizer({ emptyMode: true });

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'empty-mode-test',
    });

    await memoizedFunction({ a: 1 });
    await memoizedFunction({ a: 1 });
    expect(mock).toHaveBeenCalledTimes(2);

    await memoizer.quit();
  });
});

describe('scan all cursor', () => {
  afterAll(async () => {
    await flushRedis();
  });

  test('if we have 1000 keys we should be able to invalidate them all quickly', async () => {
    const m = await createMemoizer({ prefix: 'a' });

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = m.memoize(memoizableFunction, {
      key: 'scan-all-delete',
    });

    // Call it 1000 times with different args and one same arg
    await Promise.all(
      new Array(1000)
        .fill(null)
        .map((_, n) => memoizedFunction({ n, same: true }))
    );

    await m.invalidate('scan-all-delete', { same: true });
    await memoizedFunction({ n: 1, same: true });
    expect(mock).toHaveBeenCalledTimes(1001);

    await m.quit();
  });
});
