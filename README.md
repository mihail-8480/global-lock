# `@mojsoski/global-lock`

A global lock library for Node.js.

## Starting the Server

To start the global lock server run:

```sh
npx global-lock 
```

You may also specify `PORT` and `HOST` environment variables.

The default port is `1911` and the host is `127.0.0.1`.

## API Reference

### `createGlobalLockClient(port?, host?)`

Creates a client for the global lock server.

Returns an object that lets you create and release a lock.

```ts
{
  lock(key: string):
    Promise<{ release: () => Promise<void> }>;

  critical<T>(key: string, section: () => T):
    Promise<Awaited<T>>;

  close(): Promise<void>;
}
```

### `client.lock(key)`

Waits until a lock is available, then holds the lock and returns a function to release the lock.

```ts
const client = await createGlobalLockClient();
const lock = await client.lock("myLock");
try {
  // some code
} finally {
  lock.release();
}
```

### `client.critical(key, section)`

Waits until a lock is available, then holds the lock, calls `await section()`, and releases the lock.

```ts
const client = await createGlobalLockClient();
await client.critical("myLock", someFunction);

async function someFunction() {
  // some code
}
```

### `client.close()`

Closes the client and all releases all it's resources.

```ts
const client = await createGlobalLockClient();

try {
  // some code
} finally {
  await client.close();
}
```
