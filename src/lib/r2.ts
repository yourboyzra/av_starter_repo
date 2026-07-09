import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config.js";

let _client: S3Client | null = null;

function client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return _client;
}

export function r2Configured(): boolean {
  return !!(
    env.R2_ACCOUNT_ID &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY &&
    env.R2_BUCKET_NAME &&
    env.R2_PUBLIC_URL
  );
}

export async function uploadToR2(
  key: string,
  data: ArrayBuffer,
  contentType: string
): Promise<string> {
  await client().send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME!,
      Key: key,
      Body: Buffer.from(data),
      ContentType: contentType,
    })
  );
  return `${env.R2_PUBLIC_URL}/${key}`;
}
