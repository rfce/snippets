  // snippets-camera-focus-v3
  // Command ownership is updated on main; request/observation state uses sessionQueue.
  private(set) var snippetsHasManualFocus = false
  private var snippetsLastCommandId = 0.0
  private var snippetsFocusObservation: NSKeyValueObservation?
  private var snippetsFocusPromise: Promise?
  private var snippetsFocusTimeout: DispatchWorkItem?
  private var snippetsFocusToken = UUID()
  private var snippetsFocusDidStart = false

  private func snippetsAcceptCommand(_ commandId: Double?) -> Bool {
    guard let commandId else { return true }
    guard commandId.isFinite, commandId > snippetsLastCommandId else { return false }
    snippetsLastCommandId = commandId
    return true
  }

  private func snippetsRestoreContinuousFocus() {
    guard let device = sessionManager.currentDevice else { return }
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      if device.isFocusPointOfInterestSupported {
        device.focusPointOfInterest = CGPoint(x: 0.5, y: 0.5)
      }
      if device.isFocusModeSupported(.continuousAutoFocus) {
        device.focusMode = .continuousAutoFocus
      }
      if device.isExposurePointOfInterestSupported {
        device.exposurePointOfInterest = CGPoint(x: 0.5, y: 0.5)
      }
      if device.isExposureModeSupported(.continuousAutoExposure) {
        device.exposureMode = .continuousAutoExposure
      }
    } catch {
      // The device may already be disconnecting during teardown.
    }
  }

  private func snippetsFinishFocus(_ status: String, token: UUID) {
    guard token == snippetsFocusToken, let promise = snippetsFocusPromise else { return }
    snippetsFocusObservation?.invalidate()
    snippetsFocusObservation = nil
    snippetsFocusTimeout?.cancel()
    snippetsFocusTimeout = nil
    snippetsFocusPromise = nil
    var finalStatus = status
    if let device = sessionManager.currentDevice {
      do {
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        if device.isFocusModeSupported(.locked) {
          device.focusMode = .locked
        } else {
          finalStatus = "failed"
        }
      } catch {
        finalStatus = "failed"
      }
    } else {
      finalStatus = "failed"
    }
    // Neither fading nor an acquisition failure restarts default autofocus.
    promise.resolve(["status": finalStatus])
  }

  private func snippetsInvalidateRequestOnQueue(releaseDevice: Bool) {
    snippetsFocusToken = UUID()
    snippetsFocusObservation?.invalidate()
    snippetsFocusObservation = nil
    snippetsFocusTimeout?.cancel()
    snippetsFocusTimeout = nil
    let promise = snippetsFocusPromise
    snippetsFocusPromise = nil
    if releaseDevice { snippetsRestoreContinuousFocus() }
    promise?.resolve(["status": "cancelled"])
  }

  func snippetsCancelFocus(commandId: Double? = nil) {
    guard snippetsAcceptCommand(commandId) else { return }
    snippetsHasManualFocus = false
    sessionQueue.async { [weak self] in
      self?.snippetsInvalidateRequestOnQueue(releaseDevice: true)
    }
  }

  func snippetsFocusAsync(x: Double, y: Double, commandId: Double, promise: Promise) {
    guard snippetsAcceptCommand(commandId) else {
      promise.resolve(["status": "cancelled"])
      return
    }
    snippetsHasManualFocus = true
    guard x.isFinite, y.isFinite, bounds.width > 0, bounds.height > 0, window != nil else {
      promise.resolve(["status": "failed"])
      return
    }
    let layerPoint = CGPoint(
      x: min(1, max(0, x)) * Double(bounds.width),
      y: min(1, max(0, y)) * Double(bounds.height)
    )
    let devicePoint = previewLayer.captureDevicePointConverted(fromLayerPoint: layerPoint)

    sessionQueue.async { [weak self] in
      guard let self else {
        promise.resolve(["status": "cancelled"])
        return
      }
      self.snippetsInvalidateRequestOnQueue(releaseDevice: false)
      guard self.session.isRunning, let device = self.sessionManager.currentDevice else {
        promise.resolve(["status": "failed"])
        return
      }
      guard device.isFocusPointOfInterestSupported, device.isFocusModeSupported(.autoFocus) else {
        promise.resolve(["status": "unsupported"])
        return
      }
      let token = self.snippetsFocusToken
      self.snippetsFocusPromise = promise
      self.snippetsFocusDidStart = false
      do {
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        if device.isFocusModeSupported(.locked) {
          device.focusMode = .locked
        }
        device.focusPointOfInterest = devicePoint
        self.snippetsFocusObservation = device.observe(\.isAdjustingFocus, options: [.new]) { [weak self] device, change in
          let adjusting = change.newValue ?? device.isAdjustingFocus
          self?.sessionQueue.async { [weak self] in
            guard let self, token == self.snippetsFocusToken, self.snippetsFocusPromise != nil else { return }
            if adjusting {
              self.snippetsFocusDidStart = true
            } else if self.snippetsFocusDidStart {
              self.snippetsFinishFocus("focused", token: token)
            }
          }
        }
        device.focusMode = .autoFocus
        if device.isExposurePointOfInterestSupported {
          device.exposurePointOfInterest = devicePoint
        }
        if device.isExposureModeSupported(.continuousAutoExposure) {
          device.exposureMode = .continuousAutoExposure
        }
      } catch {
        self.snippetsFinishFocus("failed", token: token)
        return
      }
      let timeout = DispatchWorkItem { [weak self] in
        self?.snippetsFinishFocus("failed", token: token)
      }
      self.snippetsFocusTimeout = timeout
      self.sessionQueue.asyncAfter(deadline: .now() + 4.5, execute: timeout)
    }
  }
