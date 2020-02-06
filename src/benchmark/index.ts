import benny from 'benny';
import faker from 'faker';
import { sample } from 'lodash';
import { createClient } from 'redis';
import { createMemoizer } from '../lib/memoizer';

type TestSpec = [string, number];

const small: TestSpec[] = [
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000]
];

const medium: TestSpec[] = [
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 1000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000]
];

const large: TestSpec[] = [
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 10000],
  [faker.commerce.product(), 100000],
  [faker.commerce.product(), 100000],
  [faker.commerce.product(), 100000],
  [faker.commerce.product(), 100000],
  [faker.commerce.product(), 100000]
];

const TEST_KEY_TTL = 1000 * 100;

const setup = async (testSpec: TestSpec[], prefix: string) => {
  const client = createClient();

  const memoizer = createMemoizer({ client, prefix });

  await testSpec.map(async keySpec => {
    const [name, keyCount] = keySpec;
    const fn = memoizer.memoize(
      async () => {
        return faker.random.words();
      },
      { key: name, ttl: TEST_KEY_TTL }
    );

    return Promise.all(
      new Array(keyCount).fill(null).map((_, idx) => fn({ id: idx }))
    );
  });

  return memoizer;
};

benny.suite(
  'invalidation small',
  benny.add('invalidate one - small', async () => {
    const memoizer = await setup(small, 'small');

    const chosenTest = () => sample(small);
    let currentlyInvalidatingId = 0;
    const nextId = () => currentlyInvalidatingId++;

    return () => memoizer.invalidate(chosenTest()[0], { id: nextId() });
  }),
  benny.cycle(),
  benny.complete()
);

benny.suite(
  'invalidation medium',
  benny.add('invalidate one - medium', async () => {
    const memoizer = await setup(medium, 'medium');

    const chosenTest = sample(medium);
    let currentlyInvalidatingId = 0;
    const nextId = () => currentlyInvalidatingId++;

    return () => memoizer.invalidate(chosenTest[0], { id: nextId() });
  }),
  benny.cycle(),
  benny.complete()
);

benny.suite(
  'invalidation large',
  benny.add('invalidate one - large', async () => {
    const memoizer = await setup(large, 'large');

    const chosenTest = sample(large);
    let currentlyInvalidatingId = 0;
    const nextId = () => currentlyInvalidatingId++;

    return () => memoizer.invalidate(chosenTest[0], { id: nextId() });
  }),
  benny.cycle(),
  benny.complete()
);
