import ExpoModulesCore

public class PhysicalTriggersModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PhysicalTriggers")

    Events("onPanicTrigger", "onShakeTestSample")

    AsyncFunction("configureVolumeTrigger") { (config: [String: Any]) -> Bool in
      return true
    }

    AsyncFunction("configureShakeTrigger") { (config: [String: Any]) -> Bool in
      return true
    }

    AsyncFunction("startShakeTest") { (config: [String: Any]) -> Bool in
      return true
    }

    AsyncFunction("stopShakeTest") { () -> Bool in
      return true
    }

    AsyncFunction("simulateVolumePress") { () -> Bool in
      return true
    }

    AsyncFunction("simulateShake") { (jerk: Double?) -> Bool in
      return true
    }

    AsyncFunction("isVolumeTriggerEnabled") { () -> Bool in
      return false
    }

    AsyncFunction("isShakeTriggerEnabled") { () -> Bool in
      return false
    }
  }
}
