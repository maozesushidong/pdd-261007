import fs from 'node:fs';
import fsp from 'node:fs/promises';

const readSecret = async (name) => process.env[`${name}_FILE`]
  ? (await fsp.readFile(process.env[`${name}_FILE`], 'utf8')).trim()
  : process.env[name] || '';

export async function createObjectStorage() {
  let aws;
  try { aws = await import('@aws-sdk/client-s3'); } catch (error) {
    throw new Error('Object-storage adapter requires @aws-sdk/client-s3', { cause: error });
  }
  const client = new aws.S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') !== 'false',
    credentials: { accessKeyId: await readSecret('S3_ACCESS_KEY'), secretAccessKey: await readSecret('S3_SECRET_KEY') },
  });
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET is required');
  return {
    async putFile({ objectKey, file, mimeType, sha256, sizeBytes }) {
      await client.send(new aws.PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: fs.createReadStream(file),
        ContentLength: sizeBytes,
        ContentType: mimeType,
        Metadata: { sha256 },
      }));
      return { bucket, objectKey, sha256, sizeBytes, mimeType };
    },
    async head(objectKey) {
      return client.send(new aws.HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    },
  };
}
