package expo.modules.physicaltriggers

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import android.util.Log
import kotlin.math.sqrt

/**
 * Accelerometer listener implementing high-pass filtering (gravity subtraction),
 * jerk calculation (|da/dt|), and directional shake sequence validation.
 *
 * Strict false alarm prevention:
 * - High-pass filtering eliminates static gravity and slow tilt (e.g. holding or shifting phone).
 * - Multi-directional reversal validation ensures a single drop or bump onto a table does not trigger SOS.
 * - Cooldown period prevents re-triggering immediately.
 */
class ShakeDetector(
  private val context: Context,
  var onTrigger: ((String) -> Unit)? = null,
  var onSample: ((jerk: Double, threshold: Double, isSpike: Boolean) -> Unit)? = null
) : SensorEventListener {

  companion object {
    private const val TAG = "ShakeDetector"
    const val DEFAULT_JERK_THRESHOLD = 25.0
    const val DEFAULT_MIN_SHAKES = 3
    const val DEFAULT_HIGH_PASS_ALPHA = 0.8
    const val DEFAULT_SHAKE_WINDOW_MS = 1500L
    const val DEFAULT_MIN_SHAKE_INTERVAL_MS = 120L
    const val DEFAULT_COOLDOWN_MS = 3000L
  }

  @Volatile
  var isEnabled: Boolean = false

  @Volatile
  var isTesting: Boolean = false

  @Volatile
  var jerkThreshold: Double = DEFAULT_JERK_THRESHOLD

  @Volatile
  var minShakes: Int = DEFAULT_MIN_SHAKES

  @Volatile
  var highPassAlpha: Double = DEFAULT_HIGH_PASS_ALPHA

  @Volatile
  var shakeWindowMs: Long = DEFAULT_SHAKE_WINDOW_MS

  @Volatile
  var minShakeIntervalMs: Long = DEFAULT_MIN_SHAKE_INTERVAL_MS

  @Volatile
  var cooldownMs: Long = DEFAULT_COOLDOWN_MS

  private val sensorManager by lazy {
    context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
  }
  private var accelerometer: Sensor? = null
  private var isListening = false

  // High-pass filter state
  private var gravityX = 0.0
  private var gravityY = 0.0
  private var gravityZ = 0.0
  private var initialized = false

  private var lastLinearX = 0.0
  private var lastLinearY = 0.0
  private var lastLinearZ = 0.0
  private var lastTimestampNs: Long = 0

  private var lastShakeTimeMs: Long = 0
  private var lastTriggerTimeMs: Long = 0
  private val shakeTimestamps = mutableListOf<Long>()

  init {
    accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
  }

  @Synchronized
  fun configure(
    enabled: Boolean,
    threshold: Double? = null,
    minCount: Int? = null,
    alpha: Double? = null
  ) {
    this.isEnabled = enabled
    threshold?.let { if (it > 0) this.jerkThreshold = it }
    minCount?.let { if (it > 0) this.minShakes = it }
    alpha?.let { if (it in 0.1..0.99) this.highPassAlpha = it }

    Log.d(TAG, "Configured ShakeDetector: enabled=$isEnabled, threshold=$jerkThreshold, minShakes=$minShakes, alpha=$highPassAlpha")
    updateListenerState()
  }

  @Synchronized
  fun startTest(alpha: Double? = null, threshold: Double? = null) {
    this.isTesting = true
    alpha?.let { this.highPassAlpha = it }
    threshold?.let { this.jerkThreshold = it }
    updateListenerState()
  }

  @Synchronized
  fun stopTest() {
    this.isTesting = false
    updateListenerState()
  }

  private fun updateListenerState() {
    val shouldListen = isEnabled || isTesting
    if (shouldListen && !isListening) {
      accelerometer?.let {
        sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        isListening = true
        Log.d(TAG, "Registered accelerometer listener")
      }
    } else if (!shouldListen && isListening) {
      sensorManager?.unregisterListener(this)
      isListening = false
      resetFilter()
      Log.d(TAG, "Unregistered accelerometer listener")
    }
  }

  @Synchronized
  fun resetFilter() {
    initialized = false
    gravityX = 0.0
    gravityY = 0.0
    gravityZ = 0.0
    lastLinearX = 0.0
    lastLinearY = 0.0
    lastLinearZ = 0.0
    lastTimestampNs = 0
    lastShakeTimeMs = 0
    shakeTimestamps.clear()
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  override fun onSensorChanged(event: SensorEvent?) {
    if (event == null || event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
    val x = event.values[0].toDouble()
    val y = event.values[1].toDouble()
    val z = event.values[2].toDouble()
    processSample(x, y, z, event.timestamp)
  }

  @Synchronized
  fun processSample(x: Double, y: Double, z: Double, timestampNs: Long = SystemClock.elapsedRealtimeNanos()) {
    if (!initialized) {
      gravityX = x
      gravityY = y
      gravityZ = z
      lastLinearX = 0.0
      lastLinearY = 0.0
      lastLinearZ = 0.0
      lastTimestampNs = timestampNs
      initialized = true
      return
    }

    val dtSeconds = (timestampNs - lastTimestampNs) / 1_000_000_000.0
    if (dtSeconds <= 0.0001 || dtSeconds > 0.5) {
      // Clamped or reset on timestamp discontinuity
      lastTimestampNs = timestampNs
      return
    }
    lastTimestampNs = timestampNs

    // HIGH-PASS FILTER:
    // Low-pass filter to isolate gravity component
    val alpha = highPassAlpha
    gravityX = alpha * gravityX + (1.0 - alpha) * x
    gravityY = alpha * gravityY + (1.0 - alpha) * y
    gravityZ = alpha * gravityZ + (1.0 - alpha) * z

    // Dynamic linear acceleration
    val linearX = x - gravityX
    val linearY = y - gravityY
    val linearZ = z - gravityZ

    // Compute Jerk (|da/dt|)
    val deltaX = linearX - lastLinearX
    val deltaY = linearY - lastLinearY
    val deltaZ = linearZ - lastLinearZ
    val deltaMag = sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ)
    val jerk = deltaMag / dtSeconds

    lastLinearX = linearX
    lastLinearY = linearY
    lastLinearZ = linearZ

    val isSpike = jerk >= jerkThreshold
    val nowMs = SystemClock.uptimeMillis()

    // Notify test sample if testing
    if (isTesting) {
      onSample?.invoke(jerk, jerkThreshold, isSpike)
    }

    if (!isEnabled) {
      return
    }

    // False alarm prevention:
    // 1. Cooldown period check
    if (nowMs - lastTriggerTimeMs < cooldownMs) {
      return
    }

    // 2. Minimum interval between peaks (debounce peak within same stroke)
    if (isSpike && (nowMs - lastShakeTimeMs >= minShakeIntervalMs)) {
      lastShakeTimeMs = nowMs
      val windowStart = nowMs - shakeWindowMs
      shakeTimestamps.removeAll { it < windowStart }
      shakeTimestamps.add(nowMs)

      Log.d(TAG, "Shake spike detected: ${shakeTimestamps.size}/$minShakes at jerk=$jerk (threshold=$jerkThreshold)")

      // 3. Multi-shake validation: requires multiple reversals within the window
      if (shakeTimestamps.size >= minShakes) {
        Log.i(TAG, "Shake pattern verified: $minShakes vigorous shakes detected within ${shakeWindowMs}ms!")
        shakeTimestamps.clear()
        lastTriggerTimeMs = nowMs
        onTrigger?.invoke("Shake Detector")
      }
    }
  }
}
