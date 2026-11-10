  // snippets-camera-focus-v3
  var snippetsHasManualFocus = false
    private set
  private var snippetsLastCommandId = 0.0
  private var snippetsFocusSequence = 0
  private var snippetsFocusPromise: Promise? = null
  private var snippetsFocusTimeout: Runnable? = null
  private var snippetsFocusFuture: com.google.common.util.concurrent.ListenableFuture<androidx.camera.core.FocusMeteringResult>? = null

  private fun snippetsAcceptCommand(commandId: Double?): Boolean {
    // Lifecycle cleanup has no JS command ID and must not advance its counter.
    if (commandId == null) return true
    if (!commandId.isFinite() || commandId <= snippetsLastCommandId) return false
    snippetsLastCommandId = commandId
    return true
  }

  private fun snippetsInvalidateRequest(releaseMetering: Boolean) {
    snippetsFocusSequence += 1
    snippetsFocusTimeout?.let { removeCallbacks(it) }
    snippetsFocusTimeout = null
    val pendingPromise = snippetsFocusPromise
    snippetsFocusPromise = null
    val previousFuture = snippetsFocusFuture
    snippetsFocusFuture = null
    if (releaseMetering) {
      previousFuture?.cancel(true)
      camera?.cameraControl?.cancelFocusAndMetering()
    }
    // Starting the next CameraX action replaces the previous action itself.
    // A separate cancel could arrive late and undo the new focus.
    pendingPromise?.resolve(mapOf("status" to "cancelled"))
  }

  fun snippetsCancelFocus(commandId: Double? = null) {
    if (!snippetsAcceptCommand(commandId)) return
    snippetsHasManualFocus = false
    snippetsInvalidateRequest(true)
  }

  private fun snippetsFinishFocus(sequence: Int, status: String) {
    if (sequence != snippetsFocusSequence) return
    snippetsFocusTimeout?.let { removeCallbacks(it) }
    snippetsFocusTimeout = null
    val pendingPromise = snippetsFocusPromise
    snippetsFocusPromise = null
    snippetsFocusFuture = null
    pendingPromise?.resolve(mapOf("status" to status))
  }

  fun snippetsFocusAsync(x: Double, y: Double, commandId: Double, promise: Promise) {
    if (!snippetsAcceptCommand(commandId)) {
      promise.resolve(mapOf("status" to "cancelled"))
      return
    }
    snippetsInvalidateRequest(false)
    snippetsHasManualFocus = true
    val currentCamera = camera
    if (!x.isFinite() || !y.isFinite() || currentCamera == null ||
      previewView.width <= 0 || previewView.height <= 0 || !isAttachedToWindow) {
      promise.resolve(mapOf("status" to "failed"))
      return
    }

    val sequence = snippetsFocusSequence
    try {
      val px = (x.coerceIn(0.0, 1.0) * previewView.width).toFloat()
      val py = (y.coerceIn(0.0, 1.0) * previewView.height).toFloat()
      // A small AF region targets the tapped object rather than a closer
      // neighbour. Exposure can still meter a larger surrounding region.
      val focusPoint = previewView.meteringPointFactory.createPoint(px, py, 0.04f)
      val exposurePoint = previewView.meteringPointFactory.createPoint(px, py, 0.12f)
      val autofocusAction = FocusMeteringAction.Builder(focusPoint, FocusMeteringAction.FLAG_AF).build()
      if (!currentCamera.cameraInfo.isFocusMeteringSupported(autofocusAction)) {
        promise.resolve(mapOf("status" to "unsupported"))
        return
      }

      val action = FocusMeteringAction.Builder(focusPoint, FocusMeteringAction.FLAG_AF)
        .addPoint(exposurePoint, FocusMeteringAction.FLAG_AE)
        .disableAutoCancel()
        .build()
      snippetsFocusPromise = promise
      val timeout = Runnable {
        if (sequence == snippetsFocusSequence && snippetsFocusPromise != null) {
          // A reporting deadline must not hand focus back to the foreground.
          snippetsFinishFocus(sequence, "failed")
        }
      }
      snippetsFocusTimeout = timeout
      postDelayed(timeout, 4500)

      // Release the old AF lock first, and wait for CameraX to apply that
      // reset before starting the new scan. This is one native operation.
      val resetFuture = currentCamera.cameraControl.cancelFocusAndMetering()
      resetFuture.addListener({
        if (sequence == snippetsFocusSequence && snippetsFocusPromise != null) {
          try {
            resetFuture.get()
            val future = currentCamera.cameraControl.startFocusAndMetering(action)
            snippetsFocusFuture = future
            future.addListener({
              if (sequence == snippetsFocusSequence && snippetsFocusPromise != null) {
                val status = try {
                  if (future.get().isFocusSuccessful) "focused" else "failed"
                } catch (_: Exception) {
                  "failed"
                }
                snippetsFinishFocus(sequence, status)
              }
            }, ContextCompat.getMainExecutor(context))
          } catch (_: Exception) {
            snippetsFinishFocus(sequence, "failed")
          }
        }
      }, ContextCompat.getMainExecutor(context))
    } catch (_: Exception) {
      if (snippetsFocusPromise === promise) {
        snippetsFinishFocus(sequence, "failed")
      } else {
        promise.resolve(mapOf("status" to "failed"))
      }
    }
  }
