import crypto from 'crypto';
import jsonStableStringify from 'json-stable-stringify';
import { createClient, RedisClientOptions, RedisClientType } from 'redis';
import { String } from 'runtypes';
import { makeEasyRedis } from './redis';

const SafeString = String.withConstraint(
  (s) => !s.includes(':') && !s.includes('|')
);

const DEFAULT_TTL = 60 * 1000;
const DEFAULT_LOCK_TIMEOUT = 5 * 1000;

export interface MemoizerOpts {
  prefix?: string;
  client?: RedisClientType;
  clientOpts?: RedisClientOptions;
  emptyMode?: boolean;
}

export interface MemoizeOpts {
  key: string;
  lockTimeout?: number;
  ttl?: number;
}

export type MemoizedFunctionArgs = Record<string, unknown> | void;

export type MemoizableFunction<U, T extends MemoizedFunctionArgs = void> = (
  args: T
) => Promise<U>;

// (args?: T) => Promise<U>;

export interface Memoizer {
  invalidate(key: string, args: MemoizedFunctionArgs): Promise<void>;
  memoize<U, T extends MemoizedFunctionArgs>(
    fn: MemoizableFunction<U, T>,
    opts: MemoizeOpts
  ): MemoizableFunction<U, T>;
  quit(): Promise<void>;
  end(): Promise<void>;
}

export const createMemoizer = async (
  instanceOpts: MemoizerOpts
): Promise<Memoizer> => {
  if (instanceOpts.emptyMode) {
    return {
      end: () =>
        new Promise((resolve) => {
          resolve();
        }),
      invalidate: async (_key: string, _forArgs: MemoizedFunctionArgs) => {
        // do nothing
      },
      memoize: <U, T extends MemoizedFunctionArgs>(
        fn: MemoizableFunction<U, T>,
        _opts: MemoizeOpts
      ) => {
        return async (args: T): Promise<U> => {
          return fn(args);
        };
      },
      quit: async () =>
        new Promise((resolve) => {
          resolve();
        }),
    };
  }

  const client: RedisClientType = (
    instanceOpts.client
      ? instanceOpts.client
      : createClient(instanceOpts.clientOpts)
  ) as RedisClientType;

  await client.connect();

  const { withLock, pSetExAndSAdd, get, scanSetAll, delAndRem } =
    makeEasyRedis(client);

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

  const memoize = <T extends MemoizedFunctionArgs, U>(
    fn: MemoizableFunction<U, T>,
    opts: MemoizeOpts
  ) => {
    SafeString.check(opts.key);

    return async (args: T): Promise<U> => {
      const redisKey = produceKeyWithArgs(instanceOpts.prefix, opts.key, args);
      const setKey = produceSetKey(instanceOpts.prefix, opts.key);

      // attempt early memoized return
      const foundResult = await get(redisKey);
      if (foundResult) {
        return foundResult;
      }

      return withLock(
        redisKey,
        opts.lockTimeout || DEFAULT_LOCK_TIMEOUT,
        async () => {
          const foundResultAfterLock = await get(redisKey);
          if (foundResultAfterLock) {
            return foundResultAfterLock;
          }

          const result = await fn(args);
          await pSetExAndSAdd(
            setKey,
            redisKey,
            opts.ttl || DEFAULT_TTL,
            result
          );
          return result;
        }
      ) as U;
    };
  };

  const quit = async () => client.quit();

  const end = async () => client.disconnect();

  return { memoize, invalidate, quit, end };
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
  args
    ? Object.keys(args)
        .map((key) => stringifyArg(key, args[key]))
        .sort()
    : ['void'];

const stringifyArg = (key: string, value: any) =>
  `${key}:${typeof value === 'object' ? objectHash(value) : value}`;

const objectHash = (obj: Record<string, any>) => sha1(jsonStableStringify(obj));

const sha1 = (str: string) =>
  crypto.createHmac('sha1', 'memo').update(str).digest('hex');
