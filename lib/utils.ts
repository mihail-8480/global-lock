export class Resolver<T = void> {
  #promise: Promise<T>;
  #resolve: ((t: T) => void) | undefined;

  constructor() {
    this.#promise = new Promise<T>((resolve) => {
      this.#resolve = resolve;
    });
  }

  get resolve() {
    return this.#resolve;
  }

  get promise() {
    return this.#promise;
  }
}

export async function* asyncMap<T, TResult>(
  iterable: AsyncIterable<T>,
  transform: (item: T) => TResult
): AsyncIterable<TResult> {
  for await (const item of iterable) {
    yield transform(item);
  }
}

export class AsyncIterableResolver<T = void> implements AsyncIterable<T> {
  #queue: T[] = [];
  #resolveNext: ((value: T | PromiseLike<T>) => void) | null = null;
  #resolveEnd: (() => void) | null = null;
  #isEnded = false;
  #endOn?: (t: T) => boolean;

  constructor(endOn?: (t: T) => boolean) {
    this.#endOn = endOn;
  }

  next(item: T): boolean {
    if (this.#endOn && this.#endOn(item)) {
      this.end();
      return false;
    }

    if (this.#isEnded) return false;

    if (this.#resolveNext) {
      this.#resolveNext(item);
      this.#resolveNext = null;
    } else {
      this.#queue.push(item);
    }
    return true;
  }

  end() {
    this.#isEnded = true;
    if (this.#resolveEnd) {
      this.#resolveEnd();
    }
  }

  async *[Symbol.asyncIterator]() {
    while (!this.#isEnded || this.#queue.length > 0) {
      if (this.#queue.length > 0) {
        yield this.#queue.shift()!;
      } else {
        await new Promise<T>((resolve) => {
          this.#resolveNext = resolve;
        });
      }
    }
    await new Promise<void>((resolve) => {
      this.#resolveEnd = resolve;
    });
  }
}

export function incrementU32withOverflow(value: number) {
  return value === 0xffffffff ? 0 : value + 1;
}
