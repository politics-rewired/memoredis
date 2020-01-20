import redis, { ClientOpts, RedisClient } from 'redis';
import redisLock from 'redis-lock';
import { String } from 'runtypes';

const SafeString = String.withConstraint(
  s => !s.includes(':') && !s.includes('|')
);

const DEFAULT_TTL = 60 * 1000;
const DEFAULT_LOCK_TIMEOUT = 5 * 1000;

interface MemoizerOpts {
  prefix?: string;
  client?: RedisClient;
  clientOpts?: ClientOpts;
}

interface MemoizeOpts {
  key: string;
  lockTimeout?: number;
  ttl?: number;
}

interface MemoizedFunctionArgs {
  [key: string]: any;
}

type MemoizableFunction<T, U> = (args: T) => Promise<U>;

export const createMemoizer = (instanceOpts: MemoizerOpts) => {
  const client = instanceOpts.client
    ? instanceOpts.client
    : redis.createClient(instanceOpts.clientOpts);

  const cbLock = redisLock(client);
  const withLock = <T>(key, timeout, cb): Promise<T> =>
    new Promise(resolve => {
      cbLock(key, timeout, async release => {
        const result = await cb();
        release();
        return resolve(result as T);
      });
    });

  const psetex = (key: string, milliseconds: number, value: any) =>
    new Promise((resolve, reject) =>
      client.psetex(key, milliseconds, JSON.stringify(value), err =>
        err ? reject(err) : resolve(true)
      )
    );

  const get = <T>(key: string): Promise<T | null> =>
    new Promise((resolve, reject) =>
      client.get(key, (err, reply) =>
        err
          ? reject(err)
          : resolve(reply !== null ? (JSON.parse(reply) as T) : (reply as null))
      )
    );

  const scan = (match: string, cursor?: string) =>
    new Promise((resolve, reject) => {
      const callback = (err, result) => {
        if (err) {
          return reject(err);
        }

        const [newCursor, keys] = result;
        return resolve([newCursor, keys]);
      };

      return cursor
        ? client.scan(cursor, 'match', match, callback)
        : client.scan('0', 'match', match, callback);
    });

  const scanAll = async (match: string) => {
    let keys: string[] = [];
    let cursor = '1';

    while (cursor !== '0') {
      const result = await scan(match);

      cursor = result[0];
      keys = keys.concat(result[1]);
    }

    return keys;
  };

  const del = async (keys: string[]) =>
    new Promise((resolve, reject) =>
      client.del(keys, err => (err ? reject(err) : resolve(true)))
    );

  if (instanceOpts.prefix) {
    SafeString.check(instanceOpts.prefix);
  }

  const invalidate = async (key: string, forArgs: MemoizedFunctionArgs) => {
    SafeString.check(key);

    const glob =
      [produceKey(instanceOpts.prefix, key), ...stringifyArgs(forArgs)].join(
        '*'
      ) + '*';

    const cachedKeys = await scanAll(glob);

    if (cachedKeys.length > 0) {
      await del(cachedKeys);
    }
  };

  const memoize = <T, U>(fn: MemoizableFunction<T, U>, opts: MemoizeOpts) => {
    SafeString.check(opts.key);

    return async (args: T): Promise<U> => {
      const redisKey = produceKeyWithArgs(instanceOpts.prefix, opts.key, args);

      // attempt early memoized return
      const foundResult = (await get(redisKey)) as U;
      if (foundResult) {
        return foundResult;
      }

      return withLock<U>(
        redisKey,
        opts.lockTimeout || DEFAULT_LOCK_TIMEOUT,
        async () => {
          const foundResultAfterLock = await get<U>(redisKey);
          if (foundResultAfterLock) {
            return foundResultAfterLock;
          }

          const result = await fn(args);
          await psetex(redisKey, opts.ttl || DEFAULT_TTL, result);
          return result;
        }
      );
    };
  };

  return { memoize, invalidate };
};

export const produceKeyWithArgs = (
  prefix: string,
  key: string,
  args: MemoizedFunctionArgs
) => `${produceKey(prefix, key)}|${stringifyArgs(args).join('|')}`;

const produceKey = (prefix: string, key: string) =>
  prefix ? `${prefix}|${key}` : key;

const stringifyArgs = (args: MemoizedFunctionArgs) =>
  Object.keys(args)
    .map(key => stringifyArg(key, args[key]))
    .sort();

const stringifyArg = (key: string, value: any) => `${key}:${value}`;
