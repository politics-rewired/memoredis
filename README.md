# redis-memoize-invalidate

Redis memoization library with good Typescript generics, locking, and argument-wide bulk invalidation

# Usage

```
yarn add memoredis
```

## Initialization

```typescript
import memoredis from 'memoredis';

// pass options as they would directly to redis.createClient
const memoizer = memoredis({ clientOpts: 'redis://' });

// or pass in an existing client
const client = redis.createClient();
const memoizer = memoredis({ client });
```

## Basic Usage

```typescript
const expensiveDatabaseLookup = async ({ authorId, genre }) => {
  // some expensive database lookup
  return { countOfBooks: n };
};

const countOfBooksPublishedByAuthorInGenre = memoizer.memoize(
  expensiveDatabaseLookup,
  { key: 'genre-author-count', ttl: 60 * 1000 }
);

await countOfBooksPublishedByAuthorInGenre({ authorId: 4, genre: 'fiction' }); // goes to the database
await countOfBooksPublishedByAuthorInGenre({ authorId: 4, genre: 'fiction' }); // served from redis!
```

## Basic Invalidation

```typescript
await countOfBooksPublishedByAuthorInGenre({ authorId: 4, genre: 'fiction' }); // goes to the database
await memoizer.invalidate('genre-author-count', {
  authorId: 4,
  genre: 'fiction'
});
await countOfBooksPublishedByAuthorInGenre({ authorId: 4, genre: 'fiction' }); // goes to the database
```

## Bulk Partial Invalidation

```typescript
await countOfBooksPublishedByAuthorInGenre({ authorId: 4, genre: 'fiction' }); // goes to the database
await countOfBooksPublishedByAuthorInGenre({ authorId: 4, genre: 'biology' }); // goes to the database
await memoizer.invalidate('genre-author-count', {
  authorId: 4
});
await countOfBooksPublishedByAuthorInGenre({ authorId: 4, genre: 'fiction' }); // goes to the database
await countOfBooksPublishedByAuthorInGenre({ authorId: 4, genre: 'biology' }); // goes to the database
```

## Prefixes

```typescript
// optionally include a prefix for namespacing caches
const libraryA = memoredis({ prefix: 'a' });
const libraryB = memoredis({ prefix: 'b' });

const expensiveDatabaseLookup = async ({ authorId, genre }) => {
  // some expensive database lookup
  console.log('Finished looking up');
  return { countOfBooks: n };
};

const countOfBooksPublishedByAuthorInGenreInLibraryA = libraryA.memoize(
  expensiveDatabaseLookup,
  { key: 'genre-author-count', ttl: 60 * 1000 }
);

const countOfBooksPublishedByAuthorInGenreInLibraryB = libraryA.memoize(
  expensiveDatabaseLookup,
  { key: 'genre-author-count', ttl: 60 * 1000 }
);

await countOfBooksPublishedByAuthorInGenreInLibraryA({
  authorId: 4,
  genre: 'fiction'
}); // goes to the database

await countOfBooksPublishedByAuthorInGenreInLibraryB({
  authorId: 4,
  genre: 'fiction'
}); // goes to the database
```

## Locking

This library uses `redis-lock` under the hood to prevent two calls to the same function
at the same time, even when the cache is cold.

```typescript
const expensiveDatabaseLookup = async ({ authorId, genre }) => {
  // some expensive database lookup
  console.log('Finished looking up');
  return { countOfBooks: n };
};

const countOfBooksPublishedByAuthorInGenre = memoizer.memoize(
  expensiveDatabaseLookup,
  { key: 'genre-author-count', ttl: 60 * 1000 }
);

const args = { authorId: 4, genre: 'fiction' };
await Promise.all([
  countOfBooksPublishedByAuthorInGenre(args),
  countOfBooksPublishedByAuthorInGenre(args)
]);
// only logs 'Finished looking up' once
```
