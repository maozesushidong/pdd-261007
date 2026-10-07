export async function createRedisConnection(url = process.env.REDIS_URL) {
  if (!url) throw new Error('REDIS_URL is required');
  let Redis;
  try { ({ default: Redis } = await import('ioredis')); } catch (error) {
    throw new Error('Redis adapter requires the ioredis package', { cause: error });
  }
  const connection = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
  await connection.ping();
  return connection;
}

export async function createBullMq() {
  try { return await import('bullmq'); } catch (error) {
    throw new Error('Queue adapter requires the bullmq package', { cause: error });
  }
}
