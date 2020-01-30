import crypto from 'crypto';
import { jsonDateParser } from 'json-date-parser';
import jsonStableStringify from 'json-stable-stringify';
import redis, { ClientOpts, RedisClient } from 'redis';
import redisLock from 'redis-lock';
import { String } from 'runtypes';

const SafeString = String.withConstraint(
  s => !s.includes(':') && !s.includes('|')
);

const DEFAULT_TTL = 60 * 1000;
const DEFAULT_LOCK_TIMEOUT = 5 * 1000;

interface Logger {
  debug(primaryMessage: string, ...supportingData: any[]): void;
  info(primaryMessage: string, ...supportingData: any[]): void;
  warn(primaryMessage: string, ...supportingData: any[]): void;
  error(primaryMessage: string, ...supportingData: any[]): void;
}

interface MemoizerOpts {
  prefix?: string;
  client?: RedisClient;
  clientOpts?: ClientOpts;
  emptyMode?: boolean;
  logger?: Logger;
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
  if (instanceOpts.emptyMode) {
    return {
      // tslint:disable-next-line: variable-name
      invalidate: async (_key: string, _forArgs: MemoizedFunctionArgs) => {
        // do nothing
      },
      // tslint:disable-next-line: variable-name
      memoize: <T, U>(fn: MemoizableFunction<T, U>, _opts: MemoizeOpts) => {
        return async (args: T): Promise<U> => {
          return fn(args);
        };
      }
    };
  }

  const client = instanceOpts.client
    ? instanceOpts.client
    : redis.createClient(instanceOpts.clientOpts);

  const logger: Logger = instanceOpts.logger ? instanceOpts.logger : console;

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
    // tslint:disable-next-line: variable-name
    new Promise((resolve, _reject) => {
      let jsonValue;
      try {
        jsonValue = JSON.stringify(value);
      } catch (err) {
        logger.error(
          `memoredis: JSON.stringify error setting key ${key}. Raw value ${value}`,
          err
        );
        return resolve(null);
      }

      client.psetex(key, milliseconds, jsonValue, err => {
        if (err) {
          logger.error(`memoredis: redis error setting key ${key}.`, err);
          return resolve(null);
        }
        return resolve(true);
      });
    });

  const get = <T>(key: string): Promise<T | null> =>
    // tslint:disable-next-line: variable-name
    new Promise((resolve, _reject) =>
      client.get(key, (err, reply) => {
        if (err) {
          logger.error(`memoredis: redis error getting key ${key}.`, err);
          return resolve(null);
        }
        if (reply === null) {
          return resolve(null);
        }

        try {
          return resolve(JSON.parse(reply, jsonDateParser) as T);
        } catch (err) {
          logger.error(
            `memoredis: JSON parse error getting key ${key}. Reply as ${reply}`,
            err
          );
          return resolve(null);
        }
      })
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
    let cursor;

    while (cursor !== '0') {
      const result = await scan(match, cursor);

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

const stringifyArg = (key: string, value: any) =>
  `${key}:${typeof value === 'object' ? objectHash(value) : value}`;

const objectHash = obj => sha1(jsonStableStringify(obj));

const sha1 = str =>
  crypto
    .createHmac('sha1', 'memo')
    .update(str)
    .digest('hex');
