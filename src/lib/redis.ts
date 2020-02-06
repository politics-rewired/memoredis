import { jsonDateParser } from 'json-date-parser';
import { RedisClient } from 'redis';
import redisLock from 'redis-lock';
import { Logger } from './memoizer';

export const makeEasyRedis = (client: RedisClient, logger: Logger) => {
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

  const psetexAndSadd = (
    setKey: string,
    key: string,
    milliseconds: number,
    value: any
  ) =>
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

      client
        .multi()
        .sadd(setKey, key)
        .psetex(key, milliseconds, jsonValue)
        // tslint:disable-next-line: variable-name
        .exec((err, _replies) => {
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

  const scanSet = (setKey: string, match: string, cursor?: string) =>
    new Promise((resolve, reject) => {
      const callback = (err, result) => {
        if (err) {
          return reject(err);
        }

        const [newCursor, keys] = result;
        return resolve([newCursor, keys]);
      };

      return cursor
        ? client.sscan(setKey, cursor, 'match', match, callback)
        : client.sscan(setKey, '0', 'match', match, callback);
    });

  const scanSetAll = async (setKey: string, match: string) => {
    let keys: string[] = [];
    let cursor;

    while (cursor !== '0') {
      const result = await scanSet(setKey, match, cursor);
      cursor = result[0];
      keys = keys.concat(result[1]);
    }

    return keys;
  };

  const del = async (keys: string[]) =>
    new Promise((resolve, reject) =>
      client.del(keys, err => (err ? reject(err) : resolve(true)))
    );

  const delAndRem = async (setKey: string, valueKeys: string[]) =>
    new Promise((resolve, reject) =>
      client
        .multi()
        .del(valueKeys)
        .srem(setKey, valueKeys)
        // tslint:disable-next-line: variable-name
        .exec((err, _replies) => (err ? reject(err) : resolve(true)))
    );

  const sadd = async (setKey: string, valueKey: string) =>
    new Promise((resolve, reject) =>
      client.sadd(setKey, valueKey, (err, reply) =>
        err ? reject(err) : resolve(reply)
      )
    );

  const srem = async (setKey: string, valueKeys: string[]) =>
    new Promise((resolve, reject) => {
      client.srem(setKey, valueKeys, (err, reply) =>
        err ? reject(err) : resolve(reply)
      );
    });

  return {
    del,
    delAndRem,
    get,
    psetex,
    psetexAndSadd,
    sadd,
    scan,
    scanAll,
    scanSet,
    scanSetAll,
    srem,
    withLock
  };
};
