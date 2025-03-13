import { Socket } from "node:net";

export interface Reference<T> {
  value: T;
}

export interface IEncoder<T> {
  encode: (value: T) => Uint8Array;
}

export interface IDecoder<T> {
  decode: (array: Uint8Array, readOffset: Reference<number>) => Iterable<T>;
}

export type BaseRequest = {
  requestIndex: number;
};

export type CreateStreamRequest = {
  request: "createStream";
};

export type SwitchStreamRequest = {
  request: "switchStream";
  streamId: number;
};

export type CloseStreamRequest = {
  request: "closeStream";
};

export type HoldLockRequest = {
  request: "holdLock";
  lockKey: string;
};

export type ReleaseLockRequest = {
  request: "releaseLock";
  referenceId: number;
};

export type BaseResponse = {
  requestIndex: number;
};

export type CreateStreamResponse = {
  response: "createStream";
  streamId: number;
};

export type SwitchStreamResponse = {
  response: "switchStream";
};

export type CloseStreamResponse = {
  response: "closeStream";
};

export type HoldLockResponse = {
  response: "holdLock";
  referenceId: number;
};

export type ReleaseLockResponse = {
  response: "releaseLock";
};

export type ErrorResponse = {
  response: "error";
  code: ErrorCode;
};

export enum ErrorCode {
  Success = 0,
  NoStreamConnected = 1,
  StreamAlreadyConnected = 2,
  StreamNotFound = 3,
  ReferenceAlreadyReleased = 4,
  ReferenceNotInitialized = 5,
  NotEnoughResources = 6,
}

export type Response = BaseResponse &
  (
    | CreateStreamResponse
    | SwitchStreamResponse
    | CloseStreamResponse
    | HoldLockResponse
    | ReleaseLockResponse
    | ErrorResponse
  );

export type Request = BaseRequest &
  (
    | CreateStreamRequest
    | SwitchStreamRequest
    | CloseStreamRequest
    | HoldLockRequest
    | ReleaseLockRequest
  );

export enum RequestType {
  CreateStream = 0,
  SwitchStream = 1,
  CloseStream = 2,
  HoldLock = 3,
  ReleaseLock = 4,
}

export enum ResponseType {
  CreateStream = 0,
  SwitchStream = 1,
  CloseStream = 2,
  HoldLock = 3,
  ReleaseLock = 4,
  Error = 5,
}

function getRequestTypeFrom(str: Request["request"]): RequestType {
  switch (str) {
    case "createStream":
      return RequestType.CreateStream;
    case "switchStream":
      return RequestType.SwitchStream;
    case "closeStream":
      return RequestType.CloseStream;
    case "holdLock":
      return RequestType.HoldLock;
    case "releaseLock":
      return RequestType.ReleaseLock;
  }
}

function getResponseTypeFrom(str: Response["response"]): ResponseType {
  switch (str) {
    case "createStream":
      return ResponseType.CreateStream;
    case "switchStream":
      return ResponseType.SwitchStream;
    case "closeStream":
      return ResponseType.CloseStream;
    case "holdLock":
      return ResponseType.HoldLock;
    case "releaseLock":
      return ResponseType.ReleaseLock;
    case "error":
      return ResponseType.Error;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeUint32(value: number): Uint8Array {
  return new Uint8Array(new Uint32Array([value]).buffer);
}

function decodeUint32(data: Uint8Array) {
  if (data.length < 4) throw new Error("Invalid Uint32 encoding");

  const uint32Array = new Uint32Array(data);
  return uint32Array[0];
}

function getRequestData(value: Request): [0] | [number, Uint8Array] {
  switch (value.request) {
    case "createStream":
      return [0];
    case "switchStream":
      return [4, encodeUint32(value.streamId)];
    case "closeStream":
      return [0];
    case "holdLock":
      return [
        textEncoder.encode(value.lockKey).length,
        textEncoder.encode(value.lockKey),
      ];
    case "releaseLock":
      return [4, encodeUint32(value.referenceId)];
  }
}

function getResponseData(value: Response): [0] | [number, Uint8Array] {
  switch (value.response) {
    case "createStream":
      return [4, encodeUint32(value.streamId)];
    case "switchStream":
      return [0];
    case "closeStream":
      return [0];
    case "holdLock":
      return [4, encodeUint32(value.referenceId)];
    case "releaseLock":
      return [0];
    case "error":
      return [4, encodeUint32(value.code)];
  }
}

export class ResponseEncoder implements IEncoder<Response> {
  encode(value: Response) {
    const [length, data] = getResponseData(value);
    const buffer = new ArrayBuffer(12 + length);
    const view = new DataView(buffer);
    view.setUint32(0, value.requestIndex, true);
    view.setUint32(4, getResponseTypeFrom(value.response), true);
    view.setUint32(8, length, true);
    if (length > 0 && data !== undefined) {
      new Uint8Array(buffer, 12).set(data);
    }
    return new Uint8Array(buffer);
  }
}

export class RequestEncoder implements IEncoder<Request> {
  encode(value: Request) {
    const [length, data] = getRequestData(value);
    const buffer = new ArrayBuffer(12 + length);
    const view = new DataView(buffer);
    view.setUint32(0, value.requestIndex, true);
    view.setUint32(4, getRequestTypeFrom(value.request), true);
    view.setUint32(8, length, true);
    if (length > 0 && data !== undefined) {
      new Uint8Array(buffer, 12).set(data);
    }
    return new Uint8Array(buffer);
  }
}

export class ResponseDecoder implements IDecoder<Response> {
  *decode(array: Uint8Array, readOffset: Reference<number>) {
    while (readOffset.value < array.byteLength) {
      if (readOffset.value + 12 > array.byteLength) {
        return;
      }

      const requestIndex = decodeUint32(
        array.slice(readOffset.value, readOffset.value + 4)
      );
      readOffset.value += 4;

      const response = decodeUint32(
        array.slice(readOffset.value, readOffset.value + 4)
      );
      readOffset.value += 4;

      const dataLength = decodeUint32(
        array.slice(readOffset.value, readOffset.value + 4)
      );

      readOffset.value += 4;

      if (readOffset.value + dataLength > array.byteLength) {
        return;
      }

      const data = array.slice(readOffset.value, readOffset.value + dataLength);
      readOffset.value += dataLength;

      switch (response) {
        case ResponseType.CreateStream:
          yield {
            requestIndex,
            response: "createStream",
            streamId: decodeUint32(data),
          } as Response;
          break;

        case ResponseType.SwitchStream:
          yield { requestIndex, response: "switchStream" } as Response;
          break;

        case ResponseType.CloseStream:
          yield { requestIndex, response: "closeStream" } as Response;
          break;

        case ResponseType.HoldLock:
          yield {
            requestIndex,
            response: "holdLock",
            referenceId: decodeUint32(data),
          } as Response;
          break;

        case ResponseType.ReleaseLock:
          yield { requestIndex, response: "releaseLock" } as Response;
          break;

        case ResponseType.Error:
          yield {
            requestIndex,
            response: "error",
            code: decodeUint32(data),
          } as Response;
          break;

        default:
          throw new Error(`Unknown response type: ${response}`);
      }
    }
  }
}

export class RequestDecoder implements IDecoder<Request> {
  *decode(array: Uint8Array, readOffset: Reference<number>) {
    while (readOffset.value < array.byteLength) {
      if (readOffset.value + 12 > array.byteLength) {
        return;
      }

      const requestIndex = decodeUint32(
        array.slice(readOffset.value, readOffset.value + 4)
      );
      readOffset.value += 4;

      const request = decodeUint32(
        array.slice(readOffset.value, readOffset.value + 4)
      );
      readOffset.value += 4;

      const dataLength = decodeUint32(
        array.slice(readOffset.value, readOffset.value + 4)
      );

      readOffset.value += 4;

      if (readOffset.value + dataLength > array.byteLength) {
        return;
      }

      const data = array.slice(readOffset.value, readOffset.value + dataLength);
      readOffset.value += dataLength;

      switch (request) {
        case RequestType.CreateStream:
          yield { requestIndex, request: "createStream" } as Request;
          break;

        case RequestType.SwitchStream:
          yield {
            requestIndex,
            request: "switchStream",
            streamId: decodeUint32(data),
          } as Request;
          break;

        case RequestType.CloseStream:
          yield { requestIndex, request: "closeStream" } as Request;
          break;

        case RequestType.HoldLock:
          yield {
            requestIndex,
            request: "holdLock",
            lockKey: textDecoder.decode(data),
          } as Request;
          break;

        case RequestType.ReleaseLock:
          yield {
            requestIndex,
            request: "releaseLock",
            referenceId: decodeUint32(data),
          } as Request;
          break;

        default:
          throw new Error(`Unknown request type: ${request}`);
      }
    }
  }
}

export async function* wrapSocket<T>(
  decoder: IDecoder<T>,
  socket: Socket
): AsyncIterable<T> {
  let buffer = new Uint8Array(0);
  let readOffset: Reference<number> = { value: 0 };
  let isClosed = false;

  function appendData(newData: Uint8Array) {
    const merged = new Uint8Array(buffer.length + newData.length);
    merged.set(buffer);
    merged.set(newData, buffer.length);
    buffer = merged;
  }

  function waitForData(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        appendData(new Uint8Array(chunk));
        cleanup();
        resolve();
      };

      const onClose = () => {
        isClosed = true;
        cleanup();
        resolve();
      };

      const onError = (err: Error) => {
        isClosed = true;
        cleanup();
        reject(err);
      };

      function cleanup() {
        socket.off("data", onData);
        socket.off("end", onClose);
        socket.off("close", onClose);
        socket.off("error", onError);
      }

      socket.once("data", onData);
      socket.once("end", onClose);
      socket.once("close", onClose);
      socket.once("error", onError);
    });
  }

  try {
    while (!isClosed) {
      while (readOffset.value < buffer.length) {
        for (const message of decoder.decode(buffer, readOffset)) {
          yield message;
        }
        buffer = buffer.slice(readOffset.value);
        readOffset.value = 0;
      }

      if (isClosed) break;

      await waitForData();
    }
  } catch (err) {
    console.error("Socket error:", err);
  } finally {
    socket.removeAllListeners();
  }

  while (readOffset.value < buffer.length) {
    for (const message of decoder.decode(buffer, readOffset)) {
      yield message;
    }
  }
}
