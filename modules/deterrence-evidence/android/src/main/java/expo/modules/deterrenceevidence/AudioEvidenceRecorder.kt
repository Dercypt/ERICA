package expo.modules.deterrenceevidence

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.util.Base64
import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "AudioEvidenceRecorder"

class AudioEvidenceRecorder(private val context: Context) {
  private val isRecording = AtomicBoolean(false)
  private var mediaRecorder: MediaRecorder? = null
  private var currentOutputFile: File? = null
  private var startTimeMs: Long = 0

  fun isAudioRecordingActive(): Boolean {
    return isRecording.get()
  }

  @Synchronized
  fun startRecording(sessionId: String): Boolean {
    if (isRecording.getAndSet(true)) {
      return true
    }

    try {
      val outputDir = File(context.cacheDir, "evidence_temp").apply { mkdirs() }
      val outputFile = File(outputDir, "audio_${sessionId}_${System.currentTimeMillis()}.m4a")
      currentOutputFile = outputFile

      val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        MediaRecorder(context)
      } else {
        @Suppress("DEPRECATION")
        MediaRecorder()
      }

      recorder.apply {
        setAudioSource(MediaRecorder.AudioSource.MIC)
        setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        setAudioEncodingBitRate(64000)
        setAudioSamplingRate(22050)
        setOutputFile(outputFile.absolutePath)
        prepare()
        start()
      }

      mediaRecorder = recorder
      startTimeMs = System.currentTimeMillis()
      Log.i(TAG, "Audio evidence recording started for session $sessionId")
      return true
    } catch (e: Throwable) {
      Log.e(TAG, "Failed to start audio recording", e)
      isRecording.set(false)
      cleanup()
      return false
    }
  }

  @Synchronized
  fun stopRecording(): Map<String, Any>? {
    if (!isRecording.getAndSet(false)) {
      return null
    }

    val durationMs = (System.currentTimeMillis() - startTimeMs).coerceAtLeast(0)
    var base64Data = ""
    var fileSizeBytes = 0L
    val file = currentOutputFile

    var stopFailed = false
    try {
      mediaRecorder?.let {
        try {
          it.stop()
        } catch (se: Throwable) {
          // stop() throws when no valid audio was written (e.g. a very short clip); the file
          // is then not a playable recording and must not be stored as evidence.
          stopFailed = true
          Log.w(TAG, "MediaRecorder stop failed (possibly too short): ${se.message}")
        }
        it.release()
      }
      mediaRecorder = null

      if (!stopFailed && file != null && file.exists() && file.length() > 0) {
        fileSizeBytes = file.length()
        val bytes = file.readBytes()
        base64Data = Base64.encodeToString(bytes, Base64.NO_WRAP)
        // Memory & disk security: overwrite and delete temporary plaintext file immediately (Law 1)
        file.writeBytes(ByteArray(bytes.size))
        file.delete()
      }
    } catch (e: Throwable) {
      Log.e(TAG, "Error stopping audio evidence recording", e)
    } finally {
      cleanup()
    }

    if (base64Data.isEmpty()) {
      return null
    }

    return mapOf(
      "uri" to (file?.toURI()?.toString() ?: ""),
      "durationMs" to durationMs,
      "base64Data" to base64Data,
      "fileSizeBytes" to fileSizeBytes,
      "mimeType" to "audio/m4a"
    )
  }

  private fun cleanup() {
    try {
      mediaRecorder?.release()
    } catch (_: Throwable) {}
    mediaRecorder = null
    try {
      currentOutputFile?.delete()
    } catch (_: Throwable) {}
    currentOutputFile = null
  }
}
