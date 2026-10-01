import { PermissionsAndroid, Platform } from 'react-native';
import { requestLocationPermission } from '../location/locationService';

export interface EmergencyPermissionStatus {
  sms: boolean;
  location: boolean;
  notifications: boolean;
}

/**
 * Requests every runtime permission the emergency path needs, ahead of an emergency.
 *
 * SEND_SMS is a dangerous permission: declaring it in the manifest is not enough, and
 * without a runtime grant the silent SMS module reports itself unavailable, so no alert
 * could ever be sent. Already-granted permissions return immediately without a dialog.
 */
export async function requestEmergencyPermissions(): Promise<EmergencyPermissionStatus> {
  const location = await requestLocationPermission();
  if (Platform.OS !== 'android') {
    return { sms: false, location, notifications: true };
  }

  const wanted = [PermissionsAndroid.PERMISSIONS.SEND_SMS];
  const needsNotificationPermission = typeof Platform.Version === 'number' && Platform.Version >= 33;
  if (needsNotificationPermission) {
    wanted.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }

  try {
    const result = await PermissionsAndroid.requestMultiple(wanted);
    const granted = (p: string) => result[p as keyof typeof result] === PermissionsAndroid.RESULTS.GRANTED;
    return {
      sms: granted(PermissionsAndroid.PERMISSIONS.SEND_SMS),
      location,
      notifications: needsNotificationPermission
        ? granted(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
        : true,
    };
  } catch (err) {
    console.warn('[permissions] Failed to request emergency permissions:', err);
    return { sms: false, location, notifications: false };
  }
}
