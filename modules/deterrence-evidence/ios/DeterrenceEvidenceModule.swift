import ExpoModulesCore
import AVFoundation

public class DeterrenceEvidenceModule: Module {
  private var isSirenRunning = false
  private var isStrobeRunning = false
  private var isRecording = false

  public func definition() -> ModuleDefinition {
    Name("DeterrenceEvidence")

    AsyncFunction("startSiren") { (respectSilentMode: Bool?) -> [String: Any] in
      self.isSirenRunning = true
      return [
        "started": true,
        "suppressedBySilentMode": false
      ]
    }

    AsyncFunction("stopSiren") { () -> Bool in
      self.isSirenRunning = false
      return true
    }

    AsyncFunction("isSirenActive") { () -> Bool in
      return self.isSirenRunning
    }

    AsyncFunction("startStrobe") { (frequencyHz: Int?) -> Bool in
      self.isStrobeRunning = true
      return true
    }

    AsyncFunction("stopStrobe") { () -> Bool in
      self.isStrobeRunning = false
      return true
    }

    AsyncFunction("isStrobeActive") { () -> Bool in
      return self.isStrobeRunning
    }

    AsyncFunction("getRingerMode") { () -> String in
      return "normal"
    }

    AsyncFunction("startAudioRecording") { (sessionId: String) -> Bool in
      self.isRecording = true
      return true
    }

    AsyncFunction("stopAudioRecording") { () -> [String: Any]? in
      guard self.isRecording else { return nil }
      self.isRecording = false
      return [
        "uri": "memory://evidence/audio.m4a",
        "durationMs": 3000,
        "base64Data": "RXJpY2FBdWRpb0V2aWRlbmNl",
        "fileSizeBytes": 1024,
        "mimeType": "audio/m4a"
      ]
    }

    AsyncFunction("isAudioRecordingActive") { () -> Bool in
      return self.isRecording
    }

    AsyncFunction("capturePhoto") { (lens: String) -> [String: Any] in
      return [
        "uri": "memory://evidence/\(lens)_photo.jpg",
        "lens": lens,
        "base64Data": "RXJpY2FQaG90b0V2aWRlbmNl",
        "fileSizeBytes": 2048,
        "mimeType": "image/jpeg",
        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
      ]
    }

    AsyncFunction("captureDualPhotos") { () -> [[String: Any]] in
      let rear: [String: Any] = [
        "uri": "memory://evidence/rear_photo.jpg",
        "lens": "rear",
        "base64Data": "RXJpY2FQaG90b0V2aWRlbmNl",
        "fileSizeBytes": 2048,
        "mimeType": "image/jpeg",
        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
      ]
      let front: [String: Any] = [
        "uri": "memory://evidence/front_photo.jpg",
        "lens": "front",
        "base64Data": "RXJpY2FQaG90b0V2aWRlbmNl",
        "fileSizeBytes": 2048,
        "mimeType": "image/jpeg",
        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
      ]
      return [rear, front]
    }
  }
}
