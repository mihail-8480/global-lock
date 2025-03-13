#!/usr/bin/env node

import { createServer } from "node:net";
import { RemoteClient, StreamManager } from "../lib/server";
import {
  ErrorCode,
  RequestDecoder,
  ResponseEncoder,
  Response,
  wrapSocket,
  Request,
} from "../lib/protocol";

const manager = new StreamManager();
const decoder = new RequestDecoder();
const encoder = new ResponseEncoder();

const server = createServer(async (socket) => {
  const client = new RemoteClient(manager);

  function respond(response: Response) {
    if (socket.readyState === "open" || socket.readyState === "writeOnly") {
      socket.write(encoder.encode(response));
    } else if (socket.readyState === "opening") {
      setTimeout(() => {
        respond(response);
      }, 100);
    }
  }

  function handleError<T extends Exclude<unknown, number>>(
    request: Request,
    result: T | ErrorCode
  ): result is ErrorCode {
    if (typeof result === "number") {
      respond({
        requestIndex: request.requestIndex,
        response: "error",
        code: result,
      });
      return true;
    }
    return false;
  }

  try {
    for await (const request of wrapSocket(decoder, socket)) {
      switch (request.request) {
        case "createStream":
          const createStreamResult = client.createStream();
          if (handleError(request, createStreamResult)) {
            break;
          }

          respond({
            response: "createStream",
            requestIndex: request.requestIndex,
            streamId: createStreamResult.id,
          });

          break;

        case "switchStream":
          const switchStreamResult = client.switchStream(request.streamId);
          if (handleError(request, switchStreamResult)) {
            break;
          }

          for (const previousLockPromise of switchStreamResult) {
            previousLockPromise.then((referenceId) => {
              respond({
                response: "holdLock",
                requestIndex: request.requestIndex,
                referenceId,
              });
            });
          }

          Promise.allSettled(switchStreamResult).then(() => {
            respond({
              response: "switchStream",
              requestIndex: request.requestIndex,
            });
          });

          break;
        case "closeStream":
          const closeStreamResult = client.closeStream();
          if (handleError(request, closeStreamResult)) {
            break;
          }

          respond({
            response: "closeStream",
            requestIndex: request.requestIndex,
          });

          socket.end();

          break;

        case "holdLock":
          const holdLockStream = client.stream;
          if (handleError(request, holdLockStream)) {
            break;
          }

          const holdLockResponse = holdLockStream.holdLock(request.lockKey);
          if (handleError(request, holdLockResponse)) {
            break;
          }

          manager.handleLockPromise(holdLockStream.id, holdLockResponse);

          holdLockResponse.then((referenceId) => {
            respond({
              response: "holdLock",
              requestIndex: request.requestIndex,
              referenceId,
            });
          });

          break;
        case "releaseLock":
          const releaseLockStream = client.stream;
          if (handleError(request, releaseLockStream)) {
            break;
          }

          const releaseLockResponse = releaseLockStream.releaseLock(
            request.referenceId
          );
          if (handleError(request, releaseLockResponse)) {
            break;
          }

          respond({
            response: "releaseLock",
            requestIndex: request.requestIndex,
          });

          break;
      }
    }
  } finally {
    client[Symbol.dispose]();
  }
});

const port = process.env.PORT !== undefined ? Number(process.env.PORT) : 1911;
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host);
server.once("close", () => {
  manager[Symbol.dispose]();
});
