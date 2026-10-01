import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mockExpoUrl = pathToFileURL(path.resolve(process.cwd(), 'test/mockExpo.mjs')).href;
const mockAsyncStorageUrl = pathToFileURL(path.resolve(process.cwd(), 'test/mockAsyncStorage.mjs')).href;
const mockLocalAuthenticationUrl = pathToFileURL(path.resolve(process.cwd(), 'test/mockLocalAuthentication.mjs')).href;
const mockReactNativeUrl = pathToFileURL(path.resolve(process.cwd(), 'test/mockReactNative.mjs')).href;

const mockLocationUrl = pathToFileURL(path.resolve(process.cwd(), 'test/mockLocation.mjs')).href;
const mockNetInfoUrl = pathToFileURL(path.resolve(process.cwd(), 'test/mockNetInfo.mjs')).href;
const mockComponentUrl = pathToFileURL(path.resolve(process.cwd(), 'test/mockComponent.mjs')).href;
const mockSmsUrl = pathToFileURL(path.resolve(process.cwd(), 'test/mockSms.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'expo-sms') {
    return nextResolve(mockSmsUrl, context);
  }
  if (specifier.endsWith('.tsx')) {
    return nextResolve(mockComponentUrl, context);
  }
  if (specifier === 'expo' || specifier === 'expo-modules-core') {
    return nextResolve(mockExpoUrl, context);
  }
  if (specifier === 'expo-location') {
    return nextResolve(mockLocationUrl, context);
  }
  if (specifier === '@react-native-community/netinfo') {
    return nextResolve(mockNetInfoUrl, context);
  }
  if (specifier === 'expo-local-authentication') {
    return nextResolve(mockLocalAuthenticationUrl, context);
  }
  if (specifier === 'react-native') {
    return nextResolve(mockReactNativeUrl, context);
  }
  if (specifier === '@react-native-async-storage/async-storage') {
    return nextResolve(mockAsyncStorageUrl, context);
  }

  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const parentDir = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd();
      const target = path.resolve(parentDir, specifier);
      for (const ext of ['.ts', '.tsx', '.js', '.web.ts', '.web.js', '/index.ts', '/index.tsx', '/index.js']) {
        const candidate = target + ext;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          if (candidate.endsWith('.tsx')) {
            return nextResolve(mockComponentUrl, context);
          }
          return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
    }
    throw err;
  }
}
