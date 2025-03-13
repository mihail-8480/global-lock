import { Socket } from "node:net";
import {
  Request,
  RequestEncoder,
  Response,
  ResponseDecoder,
  wrapSocket,
  ErrorCode,
} from "./protocol";
import {
  AsyncIterableResolver,
  Resolver,
  incrementU32withOverflow,
  asyncMap,
} from "./utils";

const decoder = new ResponseDecoder();
const encoder = new RequestEncoder();

export class GlobalLockError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode) {
    super(`Global lock error with code: ${code}`);
    this.code = code;
  }
}

function responseHandler<T extends Response["response"]>(type: T) {
  return (response: Response) => {
    if (response.response === "error") {
      throw new GlobalLockError(response.code);
    }

    if (response.response !== type) {
      throw new TypeError(
        `Response type was '${response.response}', expected '${type}'`
      );
    }

    return response as Response & { response: T };
  };
}

export async function createGlobalLockClient(port?: number, host?: string) {
  let socket = new LockSocket(port, host);
  let shouldClose = false;
  const streamId = await socket.createStream();
  const lockResolvers = new Map<number, Resolver<void>>();

  socket.addEventListener("close", async function onClose() {
    socket.removeEventListener("close", onClose);
    if (shouldClose) {
      return;
    }
    socket = new LockSocket(port, host);
    for await (const referenceId of socket.switchStream(streamId)) {
      const resolve = lockResolvers.get(referenceId)?.resolve;
      if (resolve !== undefined) {
        resolve();
      }
    }
  });

  return {
    async lock(key: string) {
      const ref = await socket.holdLock(key);
      return {
        async release() {
          await socket.releaseLock(ref);
        },
      };
    },
    async critical<T>(key: string, section: () => T | Promise<T>) {
      const ref = await socket.holdLock(key);
      try {
        return await section();
      } finally {
        await socket.releaseLock(ref);
      }
    },
    async close() {
      shouldClose = true;

      await socket.closeStream();
      socket[Symbol.dispose]();
    },
  };
}

class LockSocket extends EventTarget {
  #socket: Socket;
  #resolvers: Map<
    number,
    Resolver<Response> | AsyncIterableResolver<Response>
  > = new Map();
  #lastRequestIndex: number = 0;

  constructor(port?: number, host?: string) {
    super();
    port ??= process.env.PORT !== undefined ? Number(process.env.PORT) : 1911;
    host ??= process.env.HOST ?? "127.0.0.1";
    const socket = new Socket();
    socket.connect({
      host,
      port,
    });
    this.#socket = socket;
    this.#socket.once("close", () => {
      this.dispatchEvent(new Event("close"));
    });
    this.#handleResponses(wrapSocket(decoder, socket));
  }

  async createStream() {
    const response = await this.#createRegularRequest("createStream", {});
    return response.streamId;
  }

  async closeStream() {
    await this.#createRegularRequest("closeStream", {});
  }

  switchStream(streamId: number) {
    return asyncMap(
      this.#createIterableRequest(
        "switchStream",
        { streamId },
        "switchStream",
        "holdLock"
      ),
      (response) => response.referenceId
    );
  }

  async holdLock(lockKey: string) {
    const response = await this.#createRegularRequest("holdLock", { lockKey });
    return response.referenceId;
  }

  async releaseLock(referenceId: number) {
    await this.#createRegularRequest("releaseLock", {
      referenceId,
    });
  }

  async *#createIterableRequest<
    TRequest extends Request["request"],
    TResponse extends Response["response"]
  >(
    requestType: TRequest,
    body: Omit<Request & { request: TRequest }, "requestIndex" | "request">,
    endOn: Response["response"],
    responseType: TResponse
  ): AsyncIterable<Response & { response: TResponse }> {
    const response = this.#sendRequest(
      {
        ...body,
        request: requestType,
      },
      () =>
        new AsyncIterableResolver((response) => {
          if (response.response === "error") {
            throw new GlobalLockError(response.code);
          }
          return response.response === endOn;
        })
    ) as AsyncIterable<Response>;

    for await (const item of response) {
      if (item.response !== responseType) {
        throw new TypeError(
          `Response type was '${item.response}', expected '${requestType}'`
        );
      }
      yield item as Response & { response: TResponse };
    }
  }

  #createRegularRequest<T extends Request["request"] & Response["response"]>(
    type: T,
    body: Omit<Request & { request: T }, "requestIndex" | "request">
  ) {
    const response = this.#sendRequest({
      ...body,
      request: type,
    }) as Promise<Response>;

    return response.then(responseHandler(type));
  }

  #sendRequest(
    request: Omit<Request, "requestIndex">,
    init?: () => Resolver<Response> | AsyncIterableResolver<Response>
  ) {
    const requestIndex = incrementU32withOverflow(this.#lastRequestIndex);
    this.#lastRequestIndex = requestIndex;
    this.#socket.write(encoder.encode({ ...request, requestIndex } as Request));

    if (init) {
      const resolver = init();
      this.#resolvers.set(requestIndex, resolver);

      if (resolver instanceof Resolver) {
        return resolver.promise;
      } else {
        return resolver as AsyncIterable<Response>;
      }
    } else {
      const resolver = new Resolver<Response>();
      this.#resolvers.set(requestIndex, resolver);
      return resolver.promise;
    }
  }

  async #handleResponses(responses: AsyncIterable<Response>) {
    for await (const response of responses) {
      const resolver = this.#resolvers.get(response.requestIndex);
      if (resolver === undefined) {
        continue;
      }

      if (resolver instanceof Resolver) {
        resolver.resolve!.call(resolver, response);
        this.#resolvers.delete(response.requestIndex);
      } else {
        if (!resolver.next(response)) {
          this.#resolvers.delete(response.requestIndex);
        }
      }
    }
  }

  [Symbol.dispose]() {
    this.#socket.destroy();
  }
}
