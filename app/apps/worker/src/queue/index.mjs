import { createBullMq, createRedisConnection } from '../../../packages/adapters/src/redis/index.mjs';

export async function createShopQueue({ queueName = 'shop-workflows', handler, concurrency = 1 }) {
  const connection = await createRedisConnection();
  const { Queue, Worker } = await createBullMq();
  const queue = new Queue(queueName, { connection });
  const worker = new Worker(queueName, async (job) => handler(job.data, job), {
    connection,
    concurrency,
    lockDuration: 300_000,
  });
  return {
    queue,
    worker,
    async scheduleShop(shopId) {
      return queue.add('run-shop', { shopId }, {
        jobId: `shop:${shopId}`,
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    },
    async close() {
      await worker.close();
      await queue.close();
      await connection.quit();
    },
  };
}
