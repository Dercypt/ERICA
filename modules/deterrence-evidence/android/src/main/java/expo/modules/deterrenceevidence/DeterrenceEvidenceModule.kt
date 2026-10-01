package expo.modules.deterrenceevidence

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class DeterrenceEvidenceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val sirenController by lazy { SirenController(context) }
  private val strobeController by lazy { StrobeController(context) }
  private val audioRecorder by lazy { AudioEvidenceRecorder(context) }
  private val photoCapturer by lazy { PhotoEvidenceCapturer(context) }

  override fun definition() = ModuleDefinition {
    Name("DeterrenceEvidence")

    AsyncFunction("startSiren") { respectSilentMode: Boolean?, promise: Promise ->
      CoroutineScope(Dispatchers.IO).launch {
        try {
          val (started, suppressed) = sirenController.startSiren(respectSilentMode ?: true)
          promise.resolve(
            mapOf(
              "started" to started,
              "suppressedBySilentMode" to suppressed
            )
          )
        } catch (e: Throwable) {
          promise.reject("SIREN_ERROR", e.message, e)
        }
      }
    }

    AsyncFunction("stopSiren") { promise: Promise ->
      CoroutineScope(Dispatchers.IO).launch {
        try {
          promise.resolve(sirenController.stopSiren())
        } catch (e: Throwable) {
          promise.reject("SIREN_STOP_ERROR", e.message, e)
        }
      }
    }

    AsyncFunction("isSirenActive") { promise: Promise ->
      promise.resolve(sirenController.isSirenActive())
    }

    AsyncFunction("startStrobe") { frequencyHz: Int?, promise: Promise ->
      CoroutineScope(Dispatchers.IO).launch {
        try {
          promise.resolve(strobeController.startStrobe(frequencyHz ?: 8))
        } catch (e: Throwable) {
          promise.reject("STROBE_ERROR", e.message, e)
        }
      }
    }

    AsyncFunction("stopStrobe") { promise: Promise ->
      CoroutineScope(Dispatchers.IO).launch {
        try {
          promise.resolve(strobeController.stopStrobe())
        } catch (e: Throwable) {
          promise.reject("STROBE_STOP_ERROR", e.message, e)
        }
      }
    }

    AsyncFunction("isStrobeActive") { promise: Promise ->
      promise.resolve(strobeController.isStrobeActive())
    }

    AsyncFunction("getRingerMode") { promise: Promise ->
      promise.resolve(sirenController.getRingerMode())
    }

    AsyncFunction("startAudioRecording") { sessionId: String, promise: Promise ->
      CoroutineScope(Dispatchers.IO).launch {
        try {
          promise.resolve(audioRecorder.startRecording(sessionId))
        } catch (e: Throwable) {
          promise.reject("AUDIO_RECORD_ERROR", e.message, e)
        }
      }
    }

    AsyncFunction("stopAudioRecording") { promise: Promise ->
      CoroutineScope(Dispatchers.IO).launch {
        try {
          val result = audioRecorder.stopRecording()
          promise.resolve(result)
        } catch (e: Throwable) {
          promise.reject("AUDIO_STOP_ERROR", e.message, e)
        }
      }
    }

    AsyncFunction("isAudioRecordingActive") { promise: Promise ->
      promise.resolve(audioRecorder.isAudioRecordingActive())
    }

    AsyncFunction("capturePhoto") { lens: String, promise: Promise ->
      CoroutineScope(Dispatchers.IO).launch {
        try {
          val result = photoCapturer.capturePhoto(lens)
          promise.resolve(result)
        } catch (e: Throwable) {
          promise.reject("PHOTO_CAPTURE_ERROR", e.message, e)
        }
      }
    }

    AsyncFunction("captureDualPhotos") { promise: Promise ->
      CoroutineScope(Dispatchers.IO).launch {
        try {
          val results = photoCapturer.captureDualPhotos()
          promise.resolve(results)
        } catch (e: Throwable) {
          promise.reject("DUAL_PHOTO_CAPTURE_ERROR", e.message, e)
        }
      }
    }
  }
}
