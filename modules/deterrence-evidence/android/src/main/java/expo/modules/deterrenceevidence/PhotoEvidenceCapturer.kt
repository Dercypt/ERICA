package expo.modules.deterrenceevidence

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

private const val TAG = "PhotoEvidenceCapturer"
private const val CAPTURE_TIMEOUT_MS = 6000L

class PhotoEvidenceCapturer(private val context: Context) {
  private val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager

  private fun findCameraId(facing: Int): String? {
    if (cameraManager == null) return null
    return try {
      cameraManager.cameraIdList.firstOrNull { id ->
        val chars = cameraManager.getCameraCharacteristics(id)
        chars.get(CameraCharacteristics.LENS_FACING) == facing
      }
    } catch (e: Throwable) {
      Log.w(TAG, "Error looking up camera ID for facing $facing", e)
      null
    }
  }

  suspend fun capturePhoto(lens: String): Map<String, Any> {
    val facing = if (lens == "front") {
      CameraCharacteristics.LENS_FACING_FRONT
    } else {
      CameraCharacteristics.LENS_FACING_BACK
    }

    val cameraId = findCameraId(facing) ?: findCameraId(CameraCharacteristics.LENS_FACING_BACK)
    if (cameraId == null || cameraManager == null) {
      throw IllegalStateException("No available camera for lens $lens")
    }

    return captureFromCamera(cameraId, lens)
  }

  @SuppressLint("MissingPermission")
  private suspend fun captureFromCamera(cameraId: String, lens: String): Map<String, Any> {
    val deferred = CompletableDeferred<ByteArray>()
    val thread = HandlerThread("EvidencePhotoThread").apply { start() }
    val handler = Handler(thread.looper)

    var cameraDevice: CameraDevice? = null
    var imageReader: ImageReader? = null

    try {
      imageReader = ImageReader.newInstance(640, 480, ImageFormat.JPEG, 2)
      imageReader.setOnImageAvailableListener({ reader ->
        val image = reader.acquireLatestImage()
        if (image != null) {
          try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            deferred.complete(bytes)
          } catch (e: Throwable) {
            deferred.completeExceptionally(e)
          } finally {
            image.close()
          }
        }
      }, handler)

      val deviceDeferred = CompletableDeferred<CameraDevice>()
      cameraManager?.openCamera(cameraId, object : CameraDevice.StateCallback() {
        override fun onOpened(camera: CameraDevice) {
          deviceDeferred.complete(camera)
        }

        override fun onDisconnected(camera: CameraDevice) {
          camera.close()
          deferred.completeExceptionally(IllegalStateException("Camera disconnected"))
        }

        override fun onError(camera: CameraDevice, error: Int) {
          camera.close()
          deferred.completeExceptionally(IllegalStateException("Camera error: $error"))
        }
      }, handler)

      cameraDevice = withTimeoutOrNull(3000L) { deviceDeferred.await() }
        ?: throw IllegalStateException("Camera open timed out")

      val sessionDeferred = CompletableDeferred<CameraCaptureSession>()
      val surfaces = listOf(imageReader.surface)

      @Suppress("DEPRECATION")
      cameraDevice.createCaptureSession(surfaces, object : CameraCaptureSession.StateCallback() {
        override fun onConfigured(session: CameraCaptureSession) {
          sessionDeferred.complete(session)
        }

        override fun onConfigureFailed(session: CameraCaptureSession) {
          deferred.completeExceptionally(IllegalStateException("Camera capture session configure failed"))
        }
      }, handler)

      val session = withTimeoutOrNull(3000L) { sessionDeferred.await() }
        ?: throw IllegalStateException("Capture session configuration timed out")

      val captureBuilder = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
        addTarget(imageReader.surface)
        set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
      }

      session.capture(captureBuilder.build(), null, handler)

      val imageBytes = withTimeoutOrNull(CAPTURE_TIMEOUT_MS) { deferred.await() }
        ?: throw IllegalStateException("Still image capture timed out")

      val base64Data = Base64.encodeToString(imageBytes, Base64.NO_WRAP)
      val timestamp = System.currentTimeMillis()

      return mapOf(
        "uri" to "memory://evidence/${lens}_$timestamp.jpg",
        "lens" to lens,
        "base64Data" to base64Data,
        "fileSizeBytes" to imageBytes.size.toLong(),
        "mimeType" to "image/jpeg",
        "timestamp" to timestamp
      )
    } finally {
      try {
        cameraDevice?.close()
      } catch (_: Throwable) {}
      try {
        imageReader?.close()
      } catch (_: Throwable) {}
      thread.quitSafely()
    }
  }

  suspend fun captureDualPhotos(): List<Map<String, Any>> {
    val results = mutableListOf<Map<String, Any>>()
    // 1. Rear camera capture
    try {
      results.add(capturePhoto("rear"))
    } catch (e: Throwable) {
      Log.w(TAG, "Rear camera capture failed: ${e.message}")
    }

    // 2. Front camera capture
    try {
      results.add(capturePhoto("front"))
    } catch (e: Throwable) {
      Log.w(TAG, "Front camera capture failed: ${e.message}")
    }

    return results
  }
}
