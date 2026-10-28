import { createHash } from 'node:crypto';
import { getParam } from '@greenlove/shared';

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

// Stored as one SecureString in Cloudinary's own format: cloudinary://<api_key>:<api_secret>@<cloud_name>
export async function getCloudinaryCredentials(): Promise<CloudinaryCredentials> {
  const url = new URL(await getParam(process.env.CLOUDINARY_URL_PARAM!, true));
  if (url.protocol !== 'cloudinary:' || !url.username || !url.password || !url.hostname) {
    throw new Error('Malformed CLOUDINARY_URL parameter');
  }
  return {
    cloudName: url.hostname,
    apiKey: decodeURIComponent(url.username),
    apiSecret: decodeURIComponent(url.password),
  };
}

/**
 * Cloudinary signed-upload signature: SHA-1 of the alphabetically sorted params
 * (excluding file, api_key, cloud_name, resource_type) joined as k=v&k=v, with the API secret appended.
 */
export function signUploadParams(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(toSign + apiSecret).digest('hex');
}

export const productImageFolder = () => `greenlove/${process.env.ENVIRONMENT}/products`;
