import redis from 'redis';
import { createMemoizer, produceKeyWithArgs } from './memoizer';

const flushRedis = () =>
  new Promise((resolve, reject) => {
    const client = redis.createClient();
    client.flushall('ASYNC', err => (err ? reject(err) : resolve(true)));
  });

const sleep = n => new Promise(resolve => setTimeout(resolve, n * 1000));

describe('produceKeyWithArgs', () => {
  test('produceKeyWithArgs should produce the same key for differently ordered objects', () => {
    expect(produceKeyWithArgs('prefix', 'key', { a: 1, b: 2 })).toEqual(
      produceKeyWithArgs('prefix', 'key', { b: 2, a: 1 })
    );
  });
});

describe('basic functionality', () => {
  beforeAll(async () => {
    await flushRedis();
  });

  afterAll(async () => {
    await flushRedis();
  });

  test('should only call function once for same args', async () => {
    const memoizer = createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'basic'
    });

    const args = { a: 4 };
    await memoizedFunction(args);
    await memoizedFunction(args);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  test('should distinguish different args', async () => {
    const memoizer = createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'different'
    });

    await memoizedFunction({ a: 1 });
    await memoizedFunction({ a: 2 });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  test('should lock duplicate calls', async () => {
    const memoizer = createMemoizer({});

    const mock = jest.fn();

    const memoizableSlowFunction = async () => {
      await sleep(1);
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableSlowFunction, {
      key: 'locking'
    });

    await Promise.all([memoizedFunction({ a: 1 }), memoizedFunction({ a: 1 })]);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('invalidation', () => {
  beforeAll(async () => {
    await flushRedis();
  });

  afterAll(async () => {
    await flushRedis();
  });

  test('should call twice if invalidated', async () => {
    const memoizer = createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'basic-invalidate'
    });

    const args = { a: 4 };
    await memoizedFunction(args);
    await memoizer.invalidate('basic-invalidate', args);
    await memoizedFunction(args);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  test('should call once if different arg is invalidated', async () => {
    const memoizer = createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'missed-invalidate'
    });

    await memoizedFunction({ a: 4 });
    await memoizer.invalidate('basic-invalidate', { a: 5 });
    await memoizedFunction({ a: 4 });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  test('should call twice if different compound covered invalidate', async () => {
    const memoizer = createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'compound-covered-invalidate'
    });

    await memoizedFunction({ a: 1, b: 2 });
    await memoizer.invalidate('compound-covered-invalidate', { a: 1 });
    await memoizedFunction({ a: 1, b: 2 });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  test('should call once if invalidation is partially wrong', async () => {
    const memoizer = createMemoizer({});

    const mock = jest.fn();

    const memoizableFunction = async () => {
      mock();
      return 4;
    };

    const memoizedFunction = memoizer.memoize(memoizableFunction, {
      key: 'compound-missed-invalidate'
    });

    await memoizedFunction({ a: 1, b: 2 });
    await memoizer.invalidate('compound-missed-invalidate', { a: 1, b: 3 });
    await memoizedFunction({ a: 1, b: 2 });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
