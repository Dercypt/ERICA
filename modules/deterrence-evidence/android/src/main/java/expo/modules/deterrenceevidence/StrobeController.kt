package expo.modules.deterrenceevidence

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "StrobeController"

class StrobeController(private val context: Context) {
  private val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
  private val isRunning = AtomicBoolean(false)
  private var strobeJob: Job? = null
  private var activeCameraId: String? = null

  private fun findTorchCameraId(): String? {
    if (cameraManager == null) return null
    return try {
      for (id in cameraManager.cameraIdList) {
        val characteristics = cameraManager.getCameraCharacteristics(id)
        val hasFlash = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        val facing = characteristics.get(CameraCharacteristics.LENS_FACING)
        if (hasFlash && facing == CameraCharacteristics.LENS_FACING_BACK) {
          return id
        }
      }
      // Fallback: any camera with flash
      cameraManager.cameraIdList.firstOrNull { id ->
        cameraManager.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
      }
    } catch (e: Throwable) {
      Log.w(TAG, "Failed to query camera flash characteristics", e)
      null
    }
  }

  fun isStrobeActive(): Boolean {
    return isRunning.get()
  }

  @Synchronized
  fun startStrobe(frequencyHz: Int = 8): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || cameraManager == null) {
      Log.w(TAG, "CameraManager or Marshmallow torch mode not available")
      return false
    }

    val cameraId = findTorchCameraId()
    if (cameraId == null) {
      Log.w(TAG, "No camera with flash unit available for strobe")
      return false
    }
    activeCameraId = cameraId

    if (isRunning.getAndSet(true)) {
      return true
    }

    val intervalMs = (1000L / frequencyHz.coerceIn(2, 20) / 2L).coerceAtLeast(40L)

    strobeJob = CoroutineScope(Dispatchers.IO).launch {
      var torchOn = false
      try {
        while (isActive && isRunning.get()) {
          torchOn = !torchOn
          try {
            cameraManager.setTorchMode(cameraId, torchOn)
          } catch (te: Throwable) {
            Log.w(TAG, "setTorchMode failed: ${te.message}")
          }
          delay(intervalMs)
        }
      } catch (e: Throwable) {
        Log.e(TAG, "Strobe loop encountered error", e)
      } finally {
        try {
          cameraManager.setTorchMode(cameraId, false)
        } catch (_: Throwable) {}
      }
    }

    return true
  }

  @Synchronized
  fun stopStrobe(): Boolean {
    isRunning.set(false)
    strobeJob?.cancel()
    strobeJob = null
    val cameraId = activeCameraId
    if (cameraId != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && cameraManager != null) {
      try {
        cameraManager.setTorchMode(cameraId, false)
      } catch (_: Throwable) {}
    }
    return true
  }
}
