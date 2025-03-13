import { ErrorCode } from "./protocol";
import { incrementU32withOverflow, Resolver } from "./utils";

class LockStream {
  id: number;
  #manager: StreamManager;
  #lastLockReference: number = 0;
  #client: RemoteClient;
  #lockReferences: Map<number, Resolver> = new Map();

  constructor(client: RemoteClient, manager: StreamManager, id: number) {
    this.id = id;
    this.#manager = manager;
    this.#client = client;
  }

  holdLock(lockKey: string) {
    const referenceId = incrementU32withOverflow(this.#lastLockReference);
    if (this.#lockReferences.has(referenceId)) {
      return ErrorCode.NotEnoughResources;
    }
    this.#lastLockReference = referenceId;

    return this.#manager.holdLock(this.#client, lockKey).then((lock) => {
      if (lock !== undefined) {
        this.#lockReferences.set(referenceId, lock);
      }
      return referenceId;
    });
  }

  releaseLock(referenceId: number) {
    const lock = this.#lockReferences.get(referenceId);
    if (lock === undefined) {
      return ErrorCode.ReferenceAlreadyReleased;
    }
    if (lock.resolve === undefined) {
      return ErrorCode.ReferenceNotInitialized;
    }
    lock.resolve();
    this.#lockReferences.delete(referenceId);
  }

  close() {
    for (const lock of this.#lockReferences.values()) {
      this.#manager.queueResolverForCleanup(lock);
    }
    this.#lockReferences.clear();
  }
}

export class StreamManager {
  #lastStreamId: number = 0;
  #streams: Map<number, LockStream> = new Map();
  #locks: Map<string, Promise<void>> = new Map();
  #cleanupResolvers: Set<Resolver> = new Set();
  #cleanupClients: Set<RemoteClient> = new Set();
  #streamPromises: Map<number, Set<Promise<number>>> = new Map();
  #cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.#cleanupInterval = setInterval(() => {
      this.collect();
    }, 1000);
  }

  #resolveLockPromise(streamId: number, promise: Promise<number>) {
    const promises = this.#streamPromises.get(streamId);
    if (promises === undefined) {
      return;
    }
    promises.delete(promise);
    if (promises.size === 0) {
      this.#streamPromises.delete(streamId);
    }
  }

  handleLockPromise(streamId: number, promise: Promise<number>) {
    const promises = this.#streamPromises.get(streamId) ?? new Set();
    promises.add(promise);
    promise.then(() => {
      this.#resolveLockPromise(streamId, promise);
    });
  }
  getLocks(streamId: number) {
    return this.#streamPromises.get(streamId) ?? [];
  }

  queueClientForCleanup(client: RemoteClient) {
    this.#cleanupClients.add(client);
  }

  queueResolverForCleanup(resolver: Resolver) {
    if (resolver.resolve !== undefined) {
      resolver.resolve();
    } else {
      this.#cleanupResolvers.add(resolver);
    }
  }

  removeStream(id: number) {
    this.#streams.delete(id);
  }

  #createLock(lockKey: string) {
    const lock = new Resolver();
    this.#locks.set(
      lockKey,
      lock.promise.finally(() => {
        this.#locks.delete(lockKey);
      })
    );
    return lock;
  }

  async holdLock(
    client: RemoteClient,
    lockKey: string
  ): Promise<Resolver | undefined> {
    if (!(client.stream instanceof LockStream)) {
      return Promise.resolve(undefined);
    }
    const lock = this.#locks.get(lockKey);
    if (lock !== undefined) {
      return lock.then(() => this.holdLock(client, lockKey));
    }
    return Promise.resolve(this.#createLock(lockKey));
  }

  createStream(client: RemoteClient) {
    const id = incrementU32withOverflow(this.#lastStreamId);
    if (this.#streams.has(id)) {
      return ErrorCode.NotEnoughResources;
    }
    this.#lastStreamId = id;

    const stream: LockStream = new LockStream(client, this, id);
    this.#streams.set(stream.id, stream);
    return stream;
  }

  findStream(streamId: number) {
    return this.#streams.get(streamId);
  }

  collect() {
    const nonCollectedResolvers: Resolver[] = [];
    for (const resolver of this.#cleanupResolvers) {
      if (resolver.resolve !== undefined) {
        resolver.resolve();
      } else {
        nonCollectedResolvers.push(resolver);
      }
    }
    this.#cleanupResolvers.clear();
    for (const resolver of nonCollectedResolvers) {
      this.#cleanupResolvers.add(resolver);
    }

    for (const client of this.#cleanupClients) {
      if (client.stream !== ErrorCode.NoStreamConnected) {
        client.closeStream();
      }
    }
    this.#cleanupClients.clear();
  }

  [Symbol.dispose]() {
    clearInterval(this.#cleanupInterval);
  }
}

export class RemoteClient {
  #stream: LockStream | undefined = undefined;
  #manager: StreamManager;

  constructor(manager: StreamManager) {
    this.#manager = manager;
  }

  createStream() {
    if (this.#stream !== undefined) {
      return ErrorCode.StreamAlreadyConnected;
    }
    const stream = this.#manager.createStream(this);
    if (stream instanceof LockStream) {
      this.#stream = stream;
    }
    return stream;
  }

  switchStream(
    streamId: number
  ):
    | ErrorCode.StreamAlreadyConnected
    | ErrorCode.StreamNotFound
    | Iterable<Promise<number>> {
    if (this.#stream !== undefined) {
      return ErrorCode.StreamAlreadyConnected;
    }
    const stream = this.#manager.findStream(streamId);
    if (stream === undefined) {
      return ErrorCode.StreamNotFound;
    }
    this.#stream = stream;

    return this.#manager.getLocks(streamId);
  }

  closeStream() {
    if (this.#stream === undefined) {
      return ErrorCode.NoStreamConnected;
    }
    const tempStream = this.#stream;
    this.#stream = undefined;
    tempStream.close();
    this.#manager.removeStream(tempStream.id);
  }

  [Symbol.dispose]() {
    this.#manager.queueClientForCleanup(this);
  }

  get stream(): LockStream | ErrorCode.NoStreamConnected {
    return this.#stream ?? ErrorCode.NoStreamConnected;
  }
}
