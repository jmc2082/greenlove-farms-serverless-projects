import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { isStaff, ok, forbidden, serverError } from '@greenlove/shared';
import { getCloudinaryCredentials, signUploadParams, productImageFolder } from '../../../lib/cloudinary';

const ALLOWED_FORMATS = 'jpg,jpeg,png,webp,heic';

// Browser uploads straight to Cloudinary with these values; the returned public_id is then saved on the product.
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');

  try {
    const { cloudName, apiKey, apiSecret } = await getCloudinaryCredentials();
    const params = {
      allowed_formats: ALLOWED_FORMATS,
      folder: productImageFolder(),
      timestamp: Math.floor(Date.now() / 1000),
    };

    return ok({
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      fields: { ...params, api_key: apiKey, signature: signUploadParams(params, apiSecret) },
    });
  } catch (err) {
    console.error('sign-image-upload error', err);
    return serverError();
  }
};
