package com.erica.sos

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.util.Log

/**
 * Handles device boot (BOOT_COMPLETED, MY_PACKAGE_REPLACED) and connectivity restoration (AIRPLANE_MODE).
 * Inspects persistent SQLite outbox queue; if pending emergency alerts exist, elevates the process
 * and immediately flushes the queue.
 */
class EricaBootReceiver : BroadcastReceiver() {

  companion object {
    private const val TAG = "EricaBootReceiver"
  }

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    Log.i(TAG, "EricaBootReceiver received action: $action")

    if (action == Intent.ACTION_AIRPLANE_MODE_CHANGED) {
      val isAirplaneModeOn = intent.getBooleanExtra("state", false)
      Log.d(TAG, "Airplane mode state changed: isAirplaneModeOn=$isAirplaneModeOn")
      if (isAirplaneModeOn) {
        // Airplane mode turned ON; wait until turned back OFF
        return
      }
    }

    // Inspect SQLite outbox queue database for buffered pending messages
    checkAndFlushPendingOutbox(context, action)
  }

  private fun checkAndFlushPendingOutbox(context: Context, sourceAction: String) {
    try {
      val dbFile = context.getDatabasePath("erica_outbox.db")
      if (!dbFile.exists()) {
        Log.d(TAG, "No erica_outbox.db database found on device")
        return
      }

      val db = SQLiteDatabase.openDatabase(dbFile.path, null, SQLiteDatabase.OPEN_READWRITE)
      val cursor = db.rawQuery(
        "SELECT COUNT(*) FROM outbox_queue WHERE status = 'PENDING' OR status = 'IN_FLIGHT'",
        null
      )
      var pendingCount = 0
      if (cursor.moveToFirst()) {
        pendingCount = cursor.getInt(0)
      }
      cursor.close()
      db.close()

      Log.i(TAG, "Found $pendingCount pending outbox item(s) following $sourceAction")

      if (pendingCount > 0) {
        // 1. Elevate process to EmergencyForegroundService so OS does not kill it during carrier handoff
        val serviceIntent = Intent().apply {
          setClassName(context.packageName, "expo.modules.foregroundservice.EmergencyForegroundService")
          action = "expo.modules.foregroundservice.ACTION_START"
          putExtra("extra_title", "Emergency Alert Active")
          putExtra("extra_message", "Flushing $pendingCount pending emergency alert(s)...")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(serviceIntent)
        } else {
          context.startService(serviceIntent)
        }

        // 2. Launch MainActivity to start React Native engine and flush queue
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
          putExtra("extra_flush_queue", true)
        }
        if (launchIntent != null) {
          context.startActivity(launchIntent)
        }
      }
    } catch (e: Exception) {
      Log.e(TAG, "Failed to check and flush pending outbox in EricaBootReceiver", e)
    }
  }
}
