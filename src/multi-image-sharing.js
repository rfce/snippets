import { requireOptionalNativeModule } from 'expo-modules-core';

const nativeModule = requireOptionalNativeModule('SnippetsMultiSharing');

export async function shareImagesToWhatsApp(urls) {
  if (!nativeModule?.shareImagesToWhatsApp) {
    throw new Error('Multiple-image WhatsApp sharing is unavailable in this app build.');
  }

  return nativeModule.shareImagesToWhatsApp(urls, 'image/*');
}
