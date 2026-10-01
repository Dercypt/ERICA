package expo.modules.deterrenceevidence

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sin

private const val TAG = "SirenController"
private const val SAMPLE_RATE = 22050

class SirenController(private val context: Context) {
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
  private val isRunning = AtomicBoolean(false)
  private var sirenJob: Job? = null
  private var audioTrack: AudioTrack? = null

  fun getRingerMode(): String {
    return when (audioManager?.ringerMode) {
      AudioManager.RINGER_MODE_SILENT -> "silent"
      AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
      else -> "normal"
    }
  }

  fun isSilentModeActive(): Boolean {
    val mode = audioManager?.ringerMode ?: AudioManager.RINGER_MODE_NORMAL
    return mode == AudioManager.RINGER_MODE_SILENT || mode == AudioManager.RINGER_MODE_VIBRATE
  }

  fun isSirenActive(): Boolean {
    return isRunning.get()
  }

  @Synchronized
  fun startSiren(respectSilentMode: Boolean = true): Pair<Boolean, Boolean> {
    if (respectSilentMode && isSilentModeActive()) {
      Log.i(TAG, "Siren suppressed: device is in silent/vibrate mode and respectSilentMode is enabled")
      return Pair(false, true)
    }

    if (isRunning.getAndSet(true)) {
      return Pair(true, false) // Already running
    }

    sirenJob = CoroutineScope(Dispatchers.IO).launch {
      try {
        val bufferSize = AudioTrack.getMinBufferSize(
          SAMPLE_RATE,
          AudioFormat.CHANNEL_OUT_MONO,
          AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(SAMPLE_RATE / 2)

        val track = AudioTrack.Builder()
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_ALARM)
              .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
              .build()
          )
          .setAudioFormat(
            AudioFormat.Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(SAMPLE_RATE)
              .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
              .build()
          )
          .setBufferSizeInBytes(bufferSize)
          .setTransferMode(AudioTrack.MODE_STREAM)
          .build()

        audioTrack = track
        track.play()

        val sampleBuffer = ShortArray(bufferSize)
        var phase = 0.0
        var currentFreq = 750.0
        var ascending = true

        while (isActive && isRunning.get()) {
          for (i in sampleBuffer.indices) {
            val angle = 2.0 * Math.PI * phase
            sampleBuffer[i] = (sin(angle) * 32000.0).toInt().toShort()

            phase += currentFreq / SAMPLE_RATE
            if (phase >= 1.0) {
              phase -= 1.0
            }

            // Dual-tone frequency sweep: oscillating between 700Hz and 1400Hz
            if (ascending) {
              currentFreq += 0.08
              if (currentFreq >= 1400.0) ascending = false
            } else {
              currentFreq -= 0.08
              if (currentFreq <= 700.0) ascending = true
            }
          }
          track.write(sampleBuffer, 0, sampleBuffer.size)
        }
      } catch (e: Throwable) {
        Log.e(TAG, "Error generating siren audio", e)
      } finally {
        cleanupTrack()
      }
    }

    return Pair(true, false)
  }

  @Synchronized
  fun stopSiren(): Boolean {
    isRunning.set(false)
    sirenJob?.cancel()
    sirenJob = null
    cleanupTrack()
    return true
  }

  private fun cleanupTrack() {
    try {
      audioTrack?.let {
        if (it.playState == AudioTrack.PLAYSTATE_PLAYING) {
          it.stop()
        }
        it.release()
      }
    } catch (e: Throwable) {
      Log.w(TAG, "Error cleaning up AudioTrack", e)
    } finally {
      audioTrack = null
    }
  }
}
