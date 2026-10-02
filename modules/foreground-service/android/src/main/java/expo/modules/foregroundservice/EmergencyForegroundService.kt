package expo.modules.foregroundservice

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Minimal Android ForegroundService for ERICA.
 * Avoids monolithic god-services by handling only:
 * 1. Process elevation and keep-alive so JS runtime, GPS fixes, and retry queues run while locked/screen off.
 * 2. Non-dismissible persistent notification with a quick native "I'M SAFE" action button.
 * 3. Temporary partial WakeLock acquisition during active dispatch only, released immediately upon resolution.
 */
class EmergencyForegroundService : Service() {

  companion object {
    private const val TAG = "EmergencyForegroundSvc"
    const val CHANNEL_ID = "erica_emergency_channel"
    const val CHANNEL_NAME = "Emergency Alert Active"
    const val NOTIFICATION_ID = 9110

    private const val REQUEST_CODE_LAUNCH = 100
    private const val REQUEST_CODE_SAFE = 101

    const val ACTION_START = "expo.modules.foregroundservice.ACTION_START"
    const val ACTION_STOP = "expo.modules.foregroundservice.ACTION_STOP"
    const val ACTION_UPDATE = "expo.modules.foregroundservice.ACTION_UPDATE"
    const val ACTION_MARK_SAFE = "expo.modules.foregroundservice.ACTION_MARK_SAFE"
    const val ACTION_ACQUIRE_WAKELOCK = "expo.modules.foregroundservice.ACTION_ACQUIRE_WAKELOCK"
    const val ACTION_RELEASE_WAKELOCK = "expo.modules.foregroundservice.ACTION_RELEASE_WAKELOCK"

    const val EXTRA_TITLE = "extra_title"
    const val EXTRA_MESSAGE = "extra_message"
    const val EXTRA_TIMEOUT_MS = "extra_timeout_ms"

    @Volatile
    var isServiceRunning: Boolean = false
      internal set

    @Volatile
    var isWakeLockActive: Boolean = false
      internal set

    private var wakeLock: PowerManager.WakeLock? = null

    /**
     * Acquires a temporary partial WakeLock to keep the CPU active during active dispatch.
     * Includes a safety timeout (default 180s) to prevent permanent battery drain.
     */
    @Synchronized
    fun acquireWakeLock(context: Context, timeoutMs: Long = 180_000L) {
      try {
        if (wakeLock == null) {
          val pm = context.applicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
          wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "erica:emergency_dispatch")?.apply {
            setReferenceCounted(false)
          }
        }
        if (wakeLock?.isHeld != true) {
          wakeLock?.acquire(timeoutMs)
          isWakeLockActive = true
          Log.d(TAG, "Temporary partial WakeLock acquired (timeout=${timeoutMs}ms)")
        }
      } catch (e: Exception) {
        Log.e(TAG, "Failed to acquire partial WakeLock", e)
      }
    }

    /**
     * Releases the partial WakeLock immediately to conserve battery.
     */
    @Synchronized
    fun releaseWakeLock() {
      try {
        if (wakeLock?.isHeld == true) {
          wakeLock?.release()
          Log.d(TAG, "Partial WakeLock released")
        }
      } catch (e: Exception) {
        Log.e(TAG, "Failed to release partial WakeLock", e)
      } finally {
        isWakeLockActive = false
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    Log.d(TAG, "EmergencyForegroundService created")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action ?: ACTION_START
    Log.d(TAG, "EmergencyForegroundService onStartCommand with action: $action")

    when (action) {
      ACTION_STOP -> {
        releaseWakeLock()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
          stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
          @Suppress("DEPRECATION")
          stopForeground(true)
        }
        stopSelf()
        isServiceRunning = false
        return START_NOT_STICKY
      }

      ACTION_MARK_SAFE -> {
        Log.d(TAG, "Native quick action button 'I\\'M SAFE' clicked from notification")
        ForegroundServiceModule.sendSafeEvent()
        return START_STICKY
      }

      ACTION_ACQUIRE_WAKELOCK -> {
        val timeout = intent?.getLongExtra(EXTRA_TIMEOUT_MS, 180_000L) ?: 180_000L
        acquireWakeLock(this, timeout)
        return START_STICKY
      }

      ACTION_RELEASE_WAKELOCK -> {
        releaseWakeLock()
        return START_STICKY
      }

      ACTION_START, ACTION_UPDATE -> {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Emergency Alert Active"
        val message = intent?.getStringExtra(EXTRA_MESSAGE) ?: "Emergency protocol active. Tap I'M SAFE to stand down."
        val notification = buildNotification(title, message)

        if (!isServiceRunning) {
          isServiceRunning = startInForeground(notification)
          if (!isServiceRunning) {
            stopSelf()
            return START_NOT_STICKY
          }
        } else {
          val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
          nm.notify(NOTIFICATION_ID, notification)
        }
        return START_STICKY
      }

      else -> return START_STICKY
    }
  }

  private fun hasPermission(permission: String): Boolean {
    return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
  }

  private fun hasLocationPermission(): Boolean {
    return hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
      hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
  }

  /**
   * Promotes the service to the foreground with types the OS will accept, most capable first.
   *
   * - Android 14+ throws SecurityException for a location-type service unless location
   *   permission is already granted; without it we fall back to specialUse.
   * - Since Android 9 a backgrounded app gets silence from the microphone and errors from the
   *   camera unless a foreground service declares the microphone / camera type (Android 11+).
   *   Phase 4 evidence capture runs exactly then (screen off, app in background), so those
   *   types are added whenever the user has granted the permission.
   */
  private fun startInForeground(notification: Notification): Boolean {
    val candidates = mutableListOf<Int>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      var full = 0
      if (hasLocationPermission()) full = full or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
      if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
        full = full or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      }
      if (hasPermission(Manifest.permission.CAMERA)) {
        full = full or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
      }
      if (full != 0) candidates.add(full)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      if (hasLocationPermission()) candidates.add(ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
      candidates.add(ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      candidates.add(ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      for (type in candidates.distinct()) {
        try {
          startForeground(NOTIFICATION_ID, notification, type)
          return true
        } catch (e: Exception) {
          // e.g. microphone/camera types are refused when the service starts from the background
          Log.e(TAG, "startForeground failed for type $type", e)
        }
      }
    }
    return try {
      startForeground(NOTIFICATION_ID, notification)
      true
    } catch (e: Exception) {
      Log.e(TAG, "startForeground failed; emergency notification unavailable", e)
      false
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL_ID) == null) {
        val channel = NotificationChannel(
          CHANNEL_ID,
          CHANNEL_NAME,
          NotificationManager.IMPORTANCE_HIGH
        ).apply {
          description = "Displays active emergency status and quick safety controls"
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
          setSound(null, null)
          enableVibration(false)
        }
        nm.createNotificationChannel(channel)
      }
    }
  }

  private fun buildNotification(title: String, message: String): Notification {
    createNotificationChannel()

    val launchIntent = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
    launchIntent.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
    val contentPendingIntent = PendingIntent.getActivity(this, REQUEST_CODE_LAUNCH, launchIntent, pendingFlags)

    val safeIntent = Intent(this, EmergencyForegroundService::class.java).apply {
      action = ACTION_MARK_SAFE
    }
    val safePendingIntent = PendingIntent.getService(this, REQUEST_CODE_SAFE, safeIntent, pendingFlags)

    val iconRes = if (applicationInfo.icon != 0) applicationInfo.icon else android.R.drawable.stat_sys_warning

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(message)
      .setSmallIcon(iconRes)
      .setOngoing(true)
      .setAutoCancel(false)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(contentPendingIntent)
      .addAction(
        NotificationCompat.Action.Builder(
          0,
          "I'M SAFE",
          safePendingIntent
        ).build()
      )
      .build()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    Log.d(TAG, "EmergencyForegroundService onTaskRemoved called (app swiped from Recent Apps switcher)")
    if (isServiceRunning) {
      Log.i(TAG, "Emergency dispatch active: retaining persistent foreground service sticky status")
    }
  }

  override fun onDestroy() {
    releaseWakeLock()
    isServiceRunning = false
    Log.d(TAG, "EmergencyForegroundService destroyed")
    super.onDestroy()
  }
}
