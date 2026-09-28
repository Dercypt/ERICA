package expo.modules.physicaltriggers

import android.content.Context
import android.util.Log
import android.view.KeyEvent
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PhysicalTriggersModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  companion object {
    private const val TAG = "PhysicalTriggersModule"
    private var instance: PhysicalTriggersModule? = null

    val volumeDetector = VolumePatternDetector { source ->
      sendPanicEvent(source)
    }

    var shakeDetector: ShakeDetector? = null

    fun onKeyEvent(event: KeyEvent): Boolean {
      return volumeDetector.onKeyEvent(event)
    }

    fun sendPanicEvent(source: String) {
      try {
        val payload = mapOf(
          "source" to source,
          "timestamp" to System.currentTimeMillis()
        )
        instance?.sendEvent("onPanicTrigger", payload)
          ?: Log.w(TAG, "PhysicalTriggersModule instance is null, cannot emit onPanicTrigger event")
      } catch (e: Exception) {
        Log.e(TAG, "Error emitting onPanicTrigger event", e)
      }
    }

    fun sendShakeSample(jerk: Double, threshold: Double, isSpike: Boolean) {
      try {
        val payload = mapOf(
          "currentJerk" to jerk,
          "jerkThreshold" to threshold,
          "isSpike" to isSpike,
          "timestamp" to System.currentTimeMillis()
        )
        instance?.sendEvent("onShakeTestSample", payload)
      } catch (e: Exception) {
        Log.e(TAG, "Error emitting onShakeTestSample event", e)
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("PhysicalTriggers")

    Events("onPanicTrigger", "onShakeTestSample")

    OnCreate {
      instance = this@PhysicalTriggersModule
      if (shakeDetector == null) {
        shakeDetector = ShakeDetector(
          context = context,
          onTrigger = { source -> sendPanicEvent(source) },
          onSample = { jerk, threshold, isSpike -> sendShakeSample(jerk, threshold, isSpike) }
        )
      }
    }

    OnDestroy {
      if (instance == this@PhysicalTriggersModule) {
        instance = null
      }
      shakeDetector?.resetFilter()
    }

    AsyncFunction("configureVolumeTrigger") { config: Map<String, Any>, promise: Promise ->
      try {
        val enabled = config["enabled"] as? Boolean ?: false
        val pressCount = (config["pressCount"] as? Number)?.toInt()
        val windowSeconds = (config["windowSeconds"] as? Number)?.toDouble()
        val windowMs = windowSeconds?.let { (it * 1000).toLong() }

        volumeDetector.configure(enabled, pressCount, windowMs)
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to configure volume trigger", e)
        promise.reject("CONFIG_ERROR", e.message, e)
      }
    }

    AsyncFunction("configureShakeTrigger") { config: Map<String, Any>, promise: Promise ->
      try {
        val enabled = config["enabled"] as? Boolean ?: false
        val threshold = (config["jerkThreshold"] as? Number)?.toDouble()
        val minShakes = (config["minShakes"] as? Number)?.toInt()
        val alpha = (config["highPassAlpha"] as? Number)?.toDouble()

        shakeDetector?.configure(enabled, threshold, minShakes, alpha)
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to configure shake trigger", e)
        promise.reject("CONFIG_ERROR", e.message, e)
      }
    }

    AsyncFunction("startShakeTest") { config: Map<String, Any>, promise: Promise ->
      try {
        val alpha = (config["highPassAlpha"] as? Number)?.toDouble()
        val threshold = (config["jerkThreshold"] as? Number)?.toDouble()
        shakeDetector?.startTest(alpha, threshold)
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to start shake test", e)
        promise.reject("TEST_ERROR", e.message, e)
      }
    }

    AsyncFunction("stopShakeTest") { promise: Promise ->
      try {
        shakeDetector?.stopTest()
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to stop shake test", e)
        promise.reject("TEST_ERROR", e.message, e)
      }
    }

    AsyncFunction("simulateVolumePress") { promise: Promise ->
      try {
        val triggered = volumeDetector.recordPress()
        promise.resolve(triggered)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to simulate volume press", e)
        promise.reject("SIMULATION_ERROR", e.message, e)
      }
    }

    AsyncFunction("simulateShake") { jerk: Double?, promise: Promise ->
      try {
        val targetJerk = jerk ?: (shakeDetector?.jerkThreshold ?: 25.0) + 10.0
        val now = System.currentTimeMillis()
        val detector = shakeDetector
        if (detector != null) {
          // Deliver simulated high jerk sample
          detector.processSample(0.0, 0.0, 9.8)
          detector.processSample(targetJerk * 0.05, 0.0, 9.8)
          detector.processSample(-targetJerk * 0.05, 0.0, 9.8)
          detector.processSample(targetJerk * 0.05, 0.0, 9.8)
        }
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to simulate shake", e)
        promise.reject("SIMULATION_ERROR", e.message, e)
      }
    }

    AsyncFunction("isVolumeTriggerEnabled") { promise: Promise ->
      promise.resolve(volumeDetector.isEnabled)
    }

    AsyncFunction("isShakeTriggerEnabled") { promise: Promise ->
      promise.resolve(shakeDetector?.isEnabled ?: false)
    }
  }
}
