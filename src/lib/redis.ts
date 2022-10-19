import { RedisClientType } from 'redis';
import { Logger } from './memoizer';
import { Lock } from 'redis-promise-lock';

export const makeEasyRedis = (client: RedisClientType, logger: Logger) => {
  const lockerRoom = new Lock(client);

  const withLock = async (key: string, timeout: number, fn: () => void) => {
    let result = null;

    try {
      await lockerRoom.acquireLock(`lock-${key}`, { ttl: timeout / 1000 });
      result = await fn();
    } catch (e) {
      logger.error(`memoredis: Failed to acquire lock or compute function`, e);
    } finally {
      await lockerRoom.releaseLock(`lock-${key}`);
    }

    return result;
  };

  const pSetEx = async (key: string, milliseconds: number, value: any) => {
    let jsonValue;
    try {
      jsonValue = JSON.stringify(value);
    } catch (err) {
      logger.error(
        `memoredis: JSON.stringify error setting key ${key}. Raw value ${value}`,
        err
      );
      return null;
    }

    return client.pSetEx(key, milliseconds, jsonValue);
  };

  const pSetExAndSAdd = async (
    setKey: string,
    key: string,
    milliseconds: number,
    value: any
  ) => {
    let jsonValue;
    try {
      jsonValue = JSON.stringify(value);
    } catch (err) {
      logger.error(
        `memoredis: JSON.stringify error setting key ${key}. Raw value ${value}`,
        err
      );
      return null;
    }

    return client
      .multi()
      .sAdd(setKey, key)
      .pSetEx(key, milliseconds, jsonValue)
      .exec();
  };

  const get = (key: string) => client.get(key);

  const scan = (match: string, cursor?: number) =>
    client.scan(cursor ?? 0, {
      MATCH: match,
    });

  const scanAll = async (match: string) => {
    let keys: string[] = [];
    let cursor;

    while (cursor !== 0) {
      const result = await scan(match, cursor);

      cursor = result.cursor;
      keys = keys.concat(result.keys);
    }

    return keys;
  };

  const scanSet = (setKey: string, match: string, cursor?: number) =>
    client.sScan(setKey, cursor ?? 0, { MATCH: match });

  const scanSetAll = async (setKey: string, match: string) => {
    let keys: string[] = [];
    let cursor;

    while (cursor !== 0) {
      const result = await scanSet(setKey, match, cursor);

      cursor = result.cursor;
      keys = keys.concat(result.members);
    }

    return keys;
  };

  const del = async (keys: string[]) => client.del(keys);

  const delAndRem = async (setKey: string, valueKeys: string[]) =>
    client.multi().del(valueKeys).sRem(setKey, valueKeys).exec();

  const sAdd = async (setKey: string, valueKey: string) =>
    client.sAdd(setKey, valueKey);

  const sRem = async (setKey: string, valueKeys: string[]) =>
    client.sRem(setKey, valueKeys);

  return {
    del,
    delAndRem,
    get,
    pSetEx,
    pSetExAndSAdd,
    sAdd,
    sRem,
    scan,
    scanAll,
    scanSet,
    scanSetAll,
    withLock,
  };
};
