package expo.modules.foregroundservice

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ForegroundServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  companion object {
    private const val TAG = "ForegroundServiceModule"
    private var instance: ForegroundServiceModule? = null

    fun sendSafeEvent() {
      try {
        instance?.sendEvent("onMarkSafe", emptyMap<String, Any>())
          ?: Log.w(TAG, "ForegroundServiceModule instance is null, cannot emit onMarkSafe event")
      } catch (e: Exception) {
        Log.e(TAG, "Error emitting onMarkSafe event", e)
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ForegroundService")

    Events("onMarkSafe")

    OnCreate {
      instance = this@ForegroundServiceModule
    }

    OnDestroy {
      if (instance == this@ForegroundServiceModule) {
        instance = null
      }
    }

    AsyncFunction("startService") { title: String?, message: String?, promise: Promise ->
      try {
        val intent = Intent(context, EmergencyForegroundService::class.java).apply {
          action = EmergencyForegroundService.ACTION_START
          title?.let { putExtra(EmergencyForegroundService.EXTRA_TITLE, it) }
          message?.let { putExtra(EmergencyForegroundService.EXTRA_MESSAGE, it) }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          ContextCompat.startForegroundService(context, intent)
        } else {
          context.startService(intent)
        }
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to start EmergencyForegroundService", e)
        promise.reject("START_SERVICE_FAILED", e.message, e)
      }
    }

    AsyncFunction("stopService") { promise: Promise ->
      try {
        // The SOS machine calls this on every entry to idle, including app start. Starting
        // a stopped service just to stop it is wasteful and throws when backgrounded.
        if (EmergencyForegroundService.isServiceRunning) {
          val intent = Intent(context, EmergencyForegroundService::class.java).apply {
            action = EmergencyForegroundService.ACTION_STOP
          }
          context.startService(intent)
        } else {
          EmergencyForegroundService.releaseWakeLock()
        }
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to stop EmergencyForegroundService", e)
        promise.reject("STOP_SERVICE_FAILED", e.message, e)
      }
    }

    AsyncFunction("updateNotification") { title: String, message: String, promise: Promise ->
      try {
        val intent = Intent(context, EmergencyForegroundService::class.java).apply {
          action = EmergencyForegroundService.ACTION_UPDATE
          putExtra(EmergencyForegroundService.EXTRA_TITLE, title)
          putExtra(EmergencyForegroundService.EXTRA_MESSAGE, message)
        }
        context.startService(intent)
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to update notification", e)
        promise.reject("UPDATE_NOTIFICATION_FAILED", e.message, e)
      }
    }

    AsyncFunction("acquireWakeLock") { timeoutMs: Double?, promise: Promise ->
      try {
        val timeout = timeoutMs?.toLong() ?: 180_000L
        EmergencyForegroundService.acquireWakeLock(context, timeout)
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to acquire WakeLock", e)
        promise.reject("ACQUIRE_WAKELOCK_FAILED", e.message, e)
      }
    }

    AsyncFunction("releaseWakeLock") { promise: Promise ->
      try {
        EmergencyForegroundService.releaseWakeLock()
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to release WakeLock", e)
        promise.reject("RELEASE_WAKELOCK_FAILED", e.message, e)
      }
    }

    AsyncFunction("isServiceRunning") { promise: Promise ->
      promise.resolve(EmergencyForegroundService.isServiceRunning)
    }

    AsyncFunction("isWakeLockActive") { promise: Promise ->
      promise.resolve(EmergencyForegroundService.isWakeLockActive)
    }
  }
}
