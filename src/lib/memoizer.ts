import crypto from 'crypto';
import jsonStableStringify from 'json-stable-stringify';
import redis, { ClientOpts, RedisClient } from 'redis';
import { String } from 'runtypes';
import { makeEasyRedis } from './redis';

const SafeString = String.withConstraint(
  s => !s.includes(':') && !s.includes('|')
);

const DEFAULT_TTL = 60 * 1000;
const DEFAULT_LOCK_TIMEOUT = 5 * 1000;

export interface Logger {
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

  const {
    withLock,
    psetexAndSadd,
    get,
    scanSetAll,
    delAndRem,
    sadd
  } = makeEasyRedis(client, logger);

  if (instanceOpts.prefix) {
    SafeString.check(instanceOpts.prefix);
  }

  const invalidate = async (key: string, forArgs: MemoizedFunctionArgs) => {
    const setKey = produceSetKey(instanceOpts.prefix, key);
    SafeString.check(key);

    const glob =
      [produceKey(instanceOpts.prefix, key), ...stringifyArgs(forArgs)].join(
        '*'
      ) + '*';

    const cachedKeys = await scanSetAll(setKey, glob);

    if (cachedKeys.length > 0) {
      await delAndRem(setKey, cachedKeys);
    }
  };

  const memoize = <T, U>(fn: MemoizableFunction<T, U>, opts: MemoizeOpts) => {
    SafeString.check(opts.key);

    return async (args: T): Promise<U> => {
      const redisKey = produceKeyWithArgs(instanceOpts.prefix, opts.key, args);
      const setKey = produceSetKey(instanceOpts.prefix, opts.key);

      // attempt early memoized return
      const foundResult = (await get(redisKey)) as U;
      if (foundResult) {
        await sadd(setKey, redisKey);
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
          await psetexAndSadd(
            setKey,
            redisKey,
            opts.ttl || DEFAULT_TTL,
            result
          );
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

const produceSetKey = (prefix: string, key: string) =>
  prefix ? `${prefix}|${key}-keyset` : `${key}-keyset`;

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
