import { createGlobalLockClient } from "./lib";

let lastWorkerIndex = 0;

async function doWork() {
  const workerIndex = lastWorkerIndex++;

  for (let i = 0; i < 100; i++) {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 100));
    console.log({ workerIndex, i });
  }
}

async function main() {
  const globalLock = await createGlobalLockClient();
  const promises: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) {
    promises.push(globalLock.critical(`workerLock`, doWork));
  }
  await Promise.allSettled(promises);
  globalLock.close();
}

void main();
